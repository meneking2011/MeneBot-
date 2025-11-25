// ===============================
//  APP.JS — PART 1/3
// ===============================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from 'uuid';

// Firebase
import { 
    initializeApp 
} from 'firebase/app';

import { 
    getAuth, 
    signInAnonymously, 
    onAuthStateChanged
} from "firebase/auth";

import {
    getFirestore,
    collection,
    query,
    onSnapshot,
    addDoc,
    orderBy,
    limit,
    serverTimestamp,
    doc,
    deleteDoc,
    writeBatch,
    getDocs,
    setDoc
} from "firebase/firestore";

// =============================================================
//  🔐 API CONFIG (YOU MUST FILL IN YOUR OWN KEYS HERE)
// =============================================================

// FIREBASE PLACEHOLDER CONFIG  
// (replace with your Firebase project's values)
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyACbU7QPgmUkvn1cmIIytlUK8FI0xBHhmE",
    authDomain: "mene-bot.firebaseapp.com",
    projectId: "mene-bot",
    storageBucket: "mene-bot.firebasestorage.app",
    messagingSenderId: "535679609146",
    appId: "1:535679609146:web:750fcd7b478d93bcae8803"
};

// GEMINI API PLACEHOLDER
const GEMINI_API_KEY = "AIzaSyD0fDB4XPYTSONxvbLTUCLznwzLWWV11ys";

// MODEL
const MODEL_NAME = "gemini-2.0-flash"; // stable model

// API ENDPOINT
const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// =============================================================
//  STREAMING FIX — Works reliably with Gemini REST
// =============================================================
function askAIStream(userText, history) {
    let full = null;
    let chunks = [];
    let idx = 0;

    const formattedHistory = history.map(msg => ({
        role: msg.sender === "user" ? "user" : "model",
        parts: [{ text: msg.text }]
    }));

    return {
        async next() {
            // First call → fetch response
            if (full === null) {
                const payload = {
                    contents: [
                        ...formattedHistory,
                        { role: "user", parts: [{ text: userText }] }
                    ],
                    systemInstruction: {
                        parts: [
                            { text: "You are Mene. Keep responses short and friendly." }
                        ]
                    }
                };

                const r = await fetch(API_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                const data = await r.json();

                full = data?.candidates?.[0]?.content?.parts?.[0]?.text || "…";

                // Split into tokens
                chunks = full.split(/(\s+)/).filter(Boolean);
            }

            // Out of chunks?
            if (idx >= chunks.length) {
                return { done: true, value: full };
            }

            // Stream 1 token
            const token = chunks[idx++];
            return { done: false, value: token };
        },

        [Symbol.asyncIterator]() {
            return this;
        }
    };
}

// =============================================================
//  LOCAL CACHE — prevents reset on refresh
// =============================================================
const LOCAL_KEY_LAST_SESSION = "mene_last_session";

// =============================================================
//  SMALL UI UTILITIES
// =============================================================
const scrollSmooth = (ref) => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
};

export default function App() {

// ----------------------------------------------
//  STATE
// ----------------------------------------------

const [db, setDb] = useState(null);
const [auth, setAuth] = useState(null);
const [userId, setUserId] = useState(null);
const [isAuthReady, setIsAuthReady] = useState(false);

const [sessions, setSessions] = useState([]);
const [currentSessionId, setCurrentSessionId] = useState(
    localStorage.getItem(LOCAL_KEY_LAST_SESSION) || null
);

const [messages, setMessages] = useState([]);
const [input, setInput] = useState("");
const [isTyping, setIsTyping] = useState(false);
const [errorMessage, setErrorMessage] = useState("");

const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 768);

// STT/TTS
const [canSpeak, setCanSpeak] = useState(false);
const recognitionRef = useRef(null);
const messageEndRef = useRef(null);

// ----------------------------------------------
//  INITIALIZE FIREBASE
// ----------------------------------------------
useEffect(() => {
    try {
        const app = initializeApp(FIREBASE_CONFIG);
        const firestore = getFirestore(app);
        const authentication = getAuth(app);

        setDb(firestore);
        setAuth(authentication);

        const unsub = onAuthStateChanged(authentication, async (user) => {
            if (!user) {
                await signInAnonymously(authentication);
            }
            setUserId(authentication.currentUser?.uid);
            setIsAuthReady(true);
        });

        return () => unsub();
    } catch (err) {
        console.error("Firebase init error:", err);
        setErrorMessage("Firebase initialization failed.");
    }
}, []);


// ----------------------------------------------
//  MORE CODE CONTINUES IN PART 2…
// ----------------------------------------------

// ===============================
//  APP.JS — PART 2/3
// ===============================

// ----------------------------------------------
//  LOAD SESSIONS
// ----------------------------------------------
useEffect(() => {
    if (!db || !userId) return;

    const ref = collection(db, "users", userId, "sessions");
    const q = query(ref, orderBy("createdAt", "desc"));

    const unsub = onSnapshot(q, snap => {
        const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setSessions(arr);

        // Pick a session automatically
        if (!currentSessionId && arr.length > 0) {
            setCurrentSessionId(arr[0].id);
            localStorage.setItem(LOCAL_KEY_LAST_SESSION, arr[0].id);
        }

        // If no sessions exist → create one
        if (arr.length === 0) createSession();
    });

    return () => unsub();
}, [db, userId]);

// ----------------------------------------------
//  LOAD MESSAGES FOR CURRENT SESSION
// ----------------------------------------------
useEffect(() => {
    if (!db || !userId || !currentSessionId) {
        setMessages([]);
        return;
    }

    const ref = collection(db, "users", userId, "sessions", currentSessionId, "messages");
    const q = query(ref, orderBy("createdAt", "asc"), limit(50));

    const unsub = onSnapshot(q, snap => {
        const arr = snap.docs.map(d => ({
            id: d.id,
            sender: d.data().sender,
            text: d.data().text
        }));
        setMessages(arr);
        scrollSmooth(messageEndRef);
    });

    return () => unsub();
}, [db, userId, currentSessionId]);

// ----------------------------------------------
//  CREATE NEW SESSION
// ----------------------------------------------
const createSession = useCallback(async () => {
    if (!db || !userId) return;

    const ref = collection(db, "users", userId, "sessions");
    const newRef = doc(ref);
    await setDoc(newRef, {
        name: "New Chat",
        createdAt: serverTimestamp()
    });

    setCurrentSessionId(newRef.id);
    localStorage.setItem(LOCAL_KEY_LAST_SESSION, newRef.id);
    setIsSidebarOpen(false);
}, [db, userId]);

// ----------------------------------------------
//  DELETE A SESSION
// ----------------------------------------------
const deleteSession = async (id) => {
    if (!db || !userId) return;

    if (!window.confirm("Delete this conversation?")) return;

    const sessionRef = doc(db, "users", userId, "sessions", id);
    const messagesRef = collection(db, "users", userId, "sessions", id, "messages");

    const batch = writeBatch(db);

    const msgDocs = await getDocs(messagesRef);
    msgDocs.forEach(d => batch.delete(d.ref));
    batch.delete(sessionRef);

    await batch.commit();

    // Switch to another session
    const remaining = sessions.filter(s => s.id !== id);
    if (remaining.length > 0) {
        setCurrentSessionId(remaining[0].id);
        localStorage.setItem(LOCAL_KEY_LAST_SESSION, remaining[0].id);
    } else {
        setCurrentSessionId(null);
        localStorage.removeItem(LOCAL_KEY_LAST_SESSION);
        createSession();
    }
};

// ----------------------------------------------
//  SAVE MESSAGE
// ----------------------------------------------
const saveMessage = async (sender, text) => {
    if (!db || !userId || !currentSessionId) return;
    const ref = collection(db, "users", userId, "sessions", currentSessionId, "messages");
    await addDoc(ref, {
        sender,
        text,
        createdAt: serverTimestamp()
    });
};

// ----------------------------------------------
//  SEND MESSAGE (STREAMING Gemini)
// ----------------------------------------------
const handleSend = useCallback(async (manualText = null) => {
    let text = manualText || input.trim();
    if (!text) return;

    setInput("");
    setIsTyping(true);
    setErrorMessage("");

    await saveMessage("user", text);

    let botText = "";
    const tempId = uuidv4();

    setMessages(prev => [...prev, { id: tempId, sender: "bot", text: "" }]);

    const stream = askAIStream(text, messages);

    try {
        for await (const chunk of stream) {
            botText += chunk;
            setMessages(prev =>
                prev.map(m =>
                    m.id === tempId ? { ...m, text: botText } : m
                )
            );
        }
    } catch (err) {
        botText = "Error generating response.";
    }

    setIsTyping(false);
    await saveMessage("bot", botText);
}, [input, messages, currentSessionId, db, userId]);

// ----------------------------------------------
//  SPEECH-TO-TEXT (WhatsApp style mic)
// ----------------------------------------------
useEffect(() => {
    if (!("webkitSpeechRecognition" in window)) return;

    const rec = new window.webkitSpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";

    rec.onresult = e => {
        const text = e.results[0][0].transcript;
        handleSend(text);
    };

    rec.onerror = e => console.error("STT error:", e.error);

    recognitionRef.current = rec;
    setCanSpeak(true);
}, []);

const startListening = () => {
    if (!recognitionRef.current) return;
    try {
        recognitionRef.current.start();
    } catch (e) {}
};

// ----------------------------------------------
//  TEXT-TO-SPEECH
// ----------------------------------------------
const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    speechSynthesis.speak(u);
};

// ----------------------------------------------
//  SIDEBAR COMPONENT
// ----------------------------------------------
const Sidebar = ({ sessions, currentSessionId, switchSession, createSession, deleteSession }) => (
    <div className="w-64 h-full bg-gray-50 border-r border-gray-200 p-4 flex flex-col">
        <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold">Chats</h2>
            <button
                className="bg-green-500 text-white px-2 py-1 rounded"
                onClick={createSession}
            >
                +
            </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
            {sessions.map(s => (
                <div
                    key={s.id}
                    onClick={() => switchSession(s.id)}
                    className={`p-3 rounded cursor-pointer ${s.id === currentSessionId
                            ? "bg-green-200 font-semibold"
                            : "bg-white hover:bg-gray-200"
                        }`}
                >
                    <div className="flex justify-between items-center">
                        <span>{s.name}</span>
                        <button
                            className="text-red-600"
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
        </div>
    </div>
);

// ----------------------------------------------
//  HEADER COMPONENT
// ----------------------------------------------
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
            Session: {sessions.find(s => s.id === currentSessionId)?.name || ""}
        </div>
    </div>
);

// ----------------------------------------------
// PART 3/3 WILL CONTAIN:
// - Final JSX Layout
// - Message list
// - Input area
// - CSS + Tailwind tweaks
// ----------------------------------------------

// ===============================
// APP.JS — PART 3/3 (FINAL)
// ===============================

// ----------------------------------------------
//  CHAT MESSAGE BUBBLE COMPONENT
// ----------------------------------------------
const MessageBubble = ({ msg, speak }) => {
    const isUser = msg.sender === "user";

    return (
        <div className={`flex w-full mb-3 ${isUser ? "justify-end" : "justify-start"}`}>
            <div
                className={`
                    max-w-[80%] px-4 py-2 rounded-2xl shadow 
                    ${isUser
                        ? "bg-green-600 text-white rounded-br-none"
                        : "bg-gray-100 text-gray-900 rounded-bl-none"}
                `}
            >
                <p className="whitespace-pre-wrap">{msg.text}</p>

                {/* TTS button (bot messages only) */}
                {!isUser && (
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

// ----------------------------------------------
//  TYPING INDICATOR
// ----------------------------------------------
const TypingIndicator = () => (
    <div className="flex justify-start mb-3">
        <div className="px-4 py-2 bg-gray-200 rounded-2xl rounded-bl-none text-gray-600">
            typing…
        </div>
    </div>
);

// ----------------------------------------------
//  MAIN RETURN UI
// ----------------------------------------------
return (
    <div className="h-screen w-screen flex flex-col bg-white">
        {/* HEADER */}
        <Header />

        <div className="flex flex-1 h-full overflow-hidden">

            {/* DESKTOP SIDEBAR */}
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

            {/* MOBILE SIDEBAR OVERLAY */}
            {isSidebarOpen && (
                <div className="md:hidden fixed inset-0 bg-black bg-opacity-40 z-40">
                    <div className="absolute left-0 top-0 bottom-0 w-64 bg-white shadow z-50">
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

            {/* MAIN CHAT PANEL */}
            <div className="flex flex-col flex-1 h-full bg-white">
                {/* MESSAGES */}
                <div className="flex-1 overflow-y-auto p-4 pb-24">
                    {messages.map((msg) => (
                        <MessageBubble key={msg.id} msg={msg} speak={speak} />
                    ))}

                    {isTyping && <TypingIndicator />}

                    <div ref={messageEndRef} />
                </div>

                {/* INPUT BAR */}
                <div className="absolute bottom-0 left-0 right-0 border-t bg-white p-3 flex items-center space-x-2">
                    {/* MICROPHONE (WhatsApp-style) */}
                    <button
                        onClick={startListening}
                        disabled={!canSpeak}
                        className="p-3 bg-green-600 text-white rounded-full shadow"
                        title="Hold to speak"
                    >
                        🎤
                    </button>

                    {/* TEXT INPUT */}
                    <input
                        type="text"
                        placeholder="Message Mene..."
                        className="flex-1 px-4 py-3 border rounded-full bg-gray-50 focus:outline-none"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") handleSend();
                        }}
                    />

                    {/* SEND BUTTON */}
                    <button
                        onClick={() => handleSend()}
                        className="px-4 py-3 bg-green-600 text-white rounded-full shadow"
                    >
                        ➤
                    </button>
                </div>
            </div>
        </div>
    </div>
);
} // END OF APP()

// ===============================
// END OF APP.JS
// ===============================
