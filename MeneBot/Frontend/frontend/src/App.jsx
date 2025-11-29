// Install required packages: npm install axios uuid
import React, { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import axios from 'axios';

// ----------------------------------------------
// LOCAL API CONFIG
// ----------------------------------------------
// ⚠️ IMPORTANT: Set the base domain URL ONLY. The '/api' path is set in the axios.create() below.
const BASE_RENDER_URL = "https://menebot-1.onrender.com"; 

// ----------------------------------------------
// AXIOS INSTANCE (THE FIX FOR 404 ERRORS)
// ----------------------------------------------
// We create a custom axios instance that ALWAYS uses the full, absolute base URL.
// This prevents the GitHub Pages subfolder path (/MeneBot-/) from being incorrectly prepended.
const api = axios.create({
  baseURL: BASE_RENDER_URL + "/api" // Ensures all calls start with https://menebot-1.onrender.com/api
});


// ----------------------------------------------
// UTILITIES
// ----------------------------------------------
const LOCAL_KEY_LAST_SESSION = "mene_last_session";

const scrollSmooth = (ref) => {
  ref.current?.scrollIntoView({ behavior: "smooth" });
};

// ----------------------------------------------
// MAIN APP COMPONENT
// ----------------------------------------------
export default function App() {
  // We no longer need db, auth, userId, or isAuthReady state variables
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(
    localStorage.getItem(LOCAL_KEY_LAST_SESSION) || null
  );
  const [messages, setMessages] = useState([]);

  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [isSidebarOpen, setIsSidebarOpen] = useState(
    window.innerWidth >= 768
  );

  // States related to Speech/TTS (Can be kept as they are client-side features)
  const [canSpeak, setCanSpeak] = useState(false);
  const recognitionRef = useRef(null);
  const messageEndRef = useRef(null);

  // -----------------------------
  // FETCH SESSIONS (Load Chats)
  // -----------------------------
  const fetchSessions = useCallback(async () => {
    try {
        // ➡️ Changed to use the 'api' instance and the relative route '/chats'
        const response = await api.get("/chats");
        const arr = response.data.data || [];
        setSessions(arr);
        
        // Handle initial session selection or creation
        if (!currentSessionId && arr.length > 0) {
            const lastSessionId = arr[0].id;
            setCurrentSessionId(lastSessionId);
            localStorage.setItem(LOCAL_KEY_LAST_SESSION, lastSessionId);
        } else if (currentSessionId && !arr.find(s => s.id === currentSessionId)) {
            // If the stored ID is gone, select the first or create a new one
             if (arr.length > 0) {
                const lastSessionId = arr[0].id;
                setCurrentSessionId(lastSessionId);
                localStorage.setItem(LOCAL_KEY_LAST_SESSION, lastSessionId);
             } else {
                // No chats exist, create a new one
                 createSession();
             }
        } else if (arr.length === 0) {
            createSession();
        }

    } catch (err) {
        console.error("Error loading sessions:", err);
        setErrorMessage("Failed to load chat sessions from the server.");
    }
  }, [currentSessionId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // -----------------------------
  // FETCH MESSAGES (Load Messages)
  // -----------------------------
  const fetchMessages = useCallback(async () => {
    if (!currentSessionId) {
      setMessages([]);
      return;
    }

    try {
        // ➡️ Changed to use the 'api' instance and the relative route
        const response = await api.get(`/chats/${currentSessionId}/messages`);
        const arr = response.data.data || [];
        setMessages(arr);
        scrollSmooth(messageEndRef);
    } catch (err) {
        console.error("Error loading messages:", err);
        setErrorMessage("Failed to load messages for this chat.");
    }
  }, [currentSessionId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);


  // -----------------------------
  // CREATE SESSION
  // -----------------------------
  const createSession = useCallback(async () => {
    try {
        // ➡️ Changed to use the 'api' instance and the relative route
        const response = await api.post("/chats", { name: "New Chat" });
        const newSession = response.data; // Should contain { id, name }

        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(newSession.id);
        localStorage.setItem(LOCAL_KEY_LAST_SESSION, newSession.id);
        setIsSidebarOpen(false);
        // Messages will be fetched by the useEffect hook watching currentSessionId
    } catch (err) {
        console.error("Error creating session:", err);
        setErrorMessage("Failed to create new chat session.");
    }
  }, []);

  // -----------------------------
  // DELETE SESSION
  // -----------------------------
  const deleteSession = async (id) => {
    if (!window.confirm("Delete this conversation?")) return;

    try {
        // ➡️ Changed to use the 'api' instance and the relative route
        await api.delete(`/chats/${id}`);
        
        const remaining = sessions.filter((s) => s.id !== id);
        setSessions(remaining);
        
        // Handle selection of the next session
        if (remaining.length > 0) {
            const nextSessionId = remaining[0].id;
            setCurrentSessionId(nextSessionId);
            localStorage.setItem(LOCAL_KEY_LAST_SESSION, nextSessionId);
        } else {
            // If no sessions are left, create a new one
            setCurrentSessionId(null);
            localStorage.removeItem(LOCAL_KEY_LAST_SESSION);
            createSession(); 
        }

    } catch (err) {
        console.error("Error deleting session:", err);
        setErrorMessage("Failed to delete chat session.");
    }
  };
  
  // -----------------------------
  // SEND MESSAGE
  // -----------------------------
  const handleSend = useCallback(async (manualText = null) => {
    const userText = manualText || input.trim();
    if (!userText || !currentSessionId) return;

    setInput("");
    setIsTyping(true);
    setErrorMessage("");

    // 1. Add temporary user message to UI
    const tempUserMsgId = uuidv4();
    const tempBotMsgId = uuidv4();

    setMessages((prev) => [
      ...prev,
      { id: tempUserMsgId, sender: "user", text: userText },
      { id: tempBotMsgId, sender: "bot", text: "" }, // Bot placeholder
    ]);
    scrollSmooth(messageEndRef);
    
    try {
        // ➡️ Changed to use the 'api' instance and the relative route
        const response = await api.post(`/chats/${currentSessionId}/messages`, {
            content: userText // Use 'content' for the body
        });
        
        const botMessage = response.data.botResponse; // Contains { id, sender, text }

        // 3. Update the bot placeholder with the actual bot message
        setMessages((prev) => 
            prev.map((m) => 
                m.id === tempBotMsgId 
                    ? { ...botMessage, id: botMessage.id || tempBotMsgId } // Replace with final message data
                    : m
            )
        );

    } catch (err) {
        console.error("API Error:", err);
        setErrorMessage(`Message failed: ${err.response?.data?.error || err.message}`);
        
        // Remove temporary bot message and show error instead
        setMessages(prev => prev.filter(m => m.id !== tempBotMsgId));
    } finally {
        setIsTyping(false);
        scrollSmooth(messageEndRef);
    }
  }, [input, currentSessionId]);

  // -----------------------------
  // SPEECH-TO-TEXT / TEXT-TO-SPEECH (Kept as is - client side)
  // -----------------------------
  // NOTE: This logic remains the same as it is client-side Web API dependent.
  // ... (Paste the SPEECH-TO-TEXT and TEXT-TO-SPEECH useEffect and functions from your guide code here)
  
  useEffect(() => {
    if (!("webkitSpeechRecognition" in window)) return;

    const rec = new window.webkitSpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      handleSend(text);
    };

    rec.onerror = (e) => console.error("STT error:", e.error);

    recognitionRef.current = rec;
    setCanSpeak(true);
  }, [handleSend]);

  const startListening = () => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.start();
    } catch (e) {}
  };

  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    speechSynthesis.speak(u);
  };


  // -----------------------------
  // UI COMPONENTS (SIDEBAR, HEADER, etc. - kept identical)
  // -----------------------------
  
  const Sidebar = ({
    sessions,
    currentSessionId,
    switchSession,
    createSession,
    deleteSession,
  }) => (
    <div className="w-64 h-full bg-gray-50 border-r border-gray-200 p-4 flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold">Chats</h2>
        <button
          className="bg-green-600 text-white px-2 py-1 rounded" // Changed to green-600 for consistency
          onClick={createSession}
        >
          +
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => switchSession(s.id)}
            className={`p-3 rounded cursor-pointer ${
              s.id === currentSessionId
                ? "bg-green-200 font-semibold"
                : "bg-white hover:bg-gray-200"
            }`}
          >
            <div className="flex justify-between items-center">
              <span>{s.name || s.title || `Chat ${s.id}`}</span> {/* Use 'name' from API response */}
              <button
                className="text-red-600 hover:bg-red-100 p-1 rounded"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          </div>
        ))}
        {sessions.length === 0 && <p className="text-gray-500">No chats. Click '+' to start.</p>}
      </div>
    </div>
  );

  const Header = () => (
    <div className="p-4 bg-green-600 text-white flex justify-between items-center shadow">
      <button
        className="md:hidden p-2 bg-green-700 rounded"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
      >
        ☰
      </button>

      <h1 className="font-bold text-lg">Mene AI</h1>
      <div className="hidden md:block text-sm opacity-75">
        Session: {sessions.find((s) => s.id === currentSessionId)?.name || "N/A"}
      </div>
    </div>
  );

  const MessageBubble = ({ msg, speak }) => {
    const isUser = msg.sender === "user";

    return (
      <div
        className={`flex w-full mb-3 ${
          isUser ? "justify-end" : "justify-start"
        }`}
      >
        <div
          className={`max-w-[80%] px-4 py-2 rounded-2xl shadow ${
            isUser
              ? "bg-green-600 text-white rounded-br-none"
              : "bg-gray-100 text-gray-900 rounded-bl-none"
          }`}
        >
          <p className="whitespace-pre-wrap">{msg.text}</p>

          {!isUser && msg.text && ( // Only show listen button if text is present
            <button
              className="mt-1 text-xs text-green-600 underline"
              onClick={() => speak(msg.text)}
            >
              🔊 Listen
            </button>
          )}
        </div>
      </div>
    );
  };

  const TypingIndicator = () => (
    <div className="flex justify-start mb-3">
      <div className="px-4 py-2 bg-gray-200 rounded-2xl rounded-bl-none text-gray-600">
        typing…
      </div>
    </div>
  );

  // -----------------------------
  // MAIN UI RENDER
  // -----------------------------
  return (
    <div className="h-screen w-screen flex flex-col bg-white">
      <Header />

      {/* Display General Error Message if set */}
      {errorMessage && (
        <div className="p-3 bg-red-100 text-red-700 font-medium text-center border-b border-red-300">
          ⚠️ {errorMessage}
        </div>
      )}

      <div className="flex flex-1 h-full overflow-hidden">
        {/* Desktop Sidebar */}
        <div className="hidden md:block">
          <Sidebar
            sessions={sessions}
            currentSessionId={currentSessionId}
            switchSession={(id) => {
              setCurrentSessionId(id);
              localStorage.setItem(LOCAL_KEY_LAST_SESSION, id);
            }}
            createSession={createSession}
            deleteSession={deleteSession}
          />
        </div>

        {/* Mobile Sidebar Overlay */}
        {isSidebarOpen && (
          <div className="md:hidden fixed inset-0 bg-black bg-opacity-40 z-40" onClick={() => setIsSidebarOpen(false)}>
            <div className="absolute left-0 top-0 bottom-0 w-64 bg-white shadow z-50" onClick={(e) => e.stopPropagation()}>
              <Sidebar
                sessions={sessions}
                currentSessionId={currentSessionId}
                switchSession={(id) => {
                  setCurrentSessionId(id);
                  setIsSidebarOpen(false);
                  localStorage.setItem(LOCAL_KEY_LAST_SESSION, id);
                }}
                createSession={() => {
                  createSession();
                  setIsSidebarOpen(false);
                }}
                deleteSession={deleteSession}
              />
            </div>
          </div>
        )}

        {/* MAIN CHAT AREA */}
        <div className="flex flex-col flex-1 h-full bg-white relative">
          <div className="flex-1 overflow-y-auto p-4 pb-24">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} speak={speak} />
            ))}

            {isTyping && <TypingIndicator />}

            <div ref={messageEndRef} />
          </div>

          {/* INPUT BAR */}
          <div className="absolute bottom-0 left-0 right-0 border-t bg-white p-3 flex items-center space-x-2">
            <button
              onClick={startListening}
              disabled={!canSpeak || isTyping}
              className={`p-3 text-white rounded-full shadow transition-colors ${
                canSpeak && !isTyping ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-400 cursor-not-allowed'
              }`}
            >
              🎤
            </button>

            <input
              type="text"
              placeholder={currentSessionId ? "Message Mene..." : "Create a new chat first..."}
              className="flex-1 px-4 py-3 border rounded-full bg-gray-50 focus:outline-none"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isTyping && currentSessionId) handleSend();
              }}
              disabled={isTyping || !currentSessionId}
            />

            <button
              onClick={() => handleSend()}
              disabled={isTyping || !input.trim() || !currentSessionId}
              className={`px-4 py-3 text-white rounded-full shadow transition-colors ${
                isTyping || !input.trim() || !currentSessionId ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}