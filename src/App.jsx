import React, { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from 'uuid';
import { 
    initializeApp 
} from 'firebase/app';
import { 
    getAuth, 
    signInAnonymously, 
    onAuthStateChanged,
} from 'firebase/auth';
import { 
    getFirestore, 
    collection, 
    query, 
    onSnapshot, 
    addDoc, 
    orderBy,
    limit,
    serverTimestamp,
    setLogLevel,
    doc,
    deleteDoc,
    writeBatch,
    getDocs,
    setDoc
} from 'firebase/firestore';


// --- CONFIGURATION FOR GITHUB DEPLOYMENT ---
// This configuration is hardcoded as environment variables are not available on GitHub Pages.
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyACbU7QPgmUkvn1cmIIytlUK8FI0xBHhmE",
    authDomain: "mene-bot.firebaseapp.com",
    projectId: "mene-bot",
    storageBucket: "mene-bot.firebasestorage.app",
    messagingSenderId: "535679609146",
    appId: "1:535679609146:web:750fcd7b478d93bcae8803",
    measurementId: "G-Q7ET9SGXB8"
};

// Use the Firebase Project ID as the logical application identifier for Firestore paths
const APP_ID = FIREBASE_CONFIG.projectId;

// Use the API key provided in the original fallback
const GEMINI_API_KEY = 'AIzaSyD0fDB4XPYTSONxvbLTUCLznwzLWWV11ys'; 

// --- API and TTS/STT Helper Functions ---
const MODEL_NAME = 'gemini-2.5-flash-preview-09-2025';
const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
const TTS_API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;


/**
 * Creates an Async Iterator that handles the AI request and simulates a stream.
 */
function askAIStream(inputText, chatHistory) {
    let fullResponse = null;
    let chunks = [];
    let chunkIndex = 0;

    const historyForAPI = chatHistory.map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
    }));

    // Manually implements the async iterator protocol
    return {
        async next() {
            try {
                // First call: make the REST API request
                if (fullResponse === null) {
                    const payload = {
                        contents: [...historyForAPI, { role: 'user', parts: [{ text: inputText }] }],
                        systemInstruction: { parts: [{ text: "You are Mene, a helpful and friendly AI assistant. Keep your responses concise." }] },
                    };

                    const response = await fetch(API_ENDPOINT, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const errorDetails = await response.json();
                        throw new Error(`${response.status} ${response.statusText}: ${errorDetails.error?.message || 'Unknown API Error'}`); 
                    }
                    
                    const data = await response.json();
                    
                    fullResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received from AI.";
                    
                    // Split the full response to simulate the streaming effect
                    chunks = fullResponse.split(/(\s+)/).filter(c => c.length > 0); 
                }

                // Subsequent calls: Stream out the chunks one by one
                if (chunkIndex >= chunks.length) {
                    return { done: true, value: fullResponse }; 
                }

                await new Promise((r) => setTimeout(r, 0));


                const chunk = chunks[chunkIndex++];
                return { value: chunk, done: false };

            } catch (error) {
                console.error("Gemini API Error:", error);
                return { value: `ERROR: Failed to connect to AI. Details: ${error.message}`, done: true };
            }
        },
        [Symbol.asyncIterator]() {
            return this;
        }
    };
}


/**
 * Converts a base64 string to an ArrayBuffer.
 */
const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

/**
 * Writes a string to a DataView at a specified offset.
 */
const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};

/**
 * Converts PCM (raw audio data) to a standard WAV format Blob.
 */
const pcmToWav = (pcm16, sampleRate) => {
    const numChannels = 1;
    const numSamples = pcm16.length;
    const byteRate = sampleRate * numChannels * 2; 
    const blockAlign = numChannels * 2;

    const buffer = new ArrayBuffer(44 + pcm16.byteLength);
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcm16.byteLength, true);
    writeString(view, 8, 'WAVE');
    
    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // Audio format 1 (PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // Bits per sample
    
    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcm16.byteLength, true);

    // PCM data
    const pcmView = new Int16Array(buffer, 44);
    pcmView.set(pcm16);

    return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * Makes the TTS API call and returns an Audio URL.
 */
const ttsApiCall = async (text, setErrorMessage) => {
    if (!text) return null;

    try {
        const payload = {
            contents: [{ parts: [{ text: text }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: "Achird" } 
                    }
                }
            }
        };

        const response = await fetch(TTS_API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`TTS API failed with status ${response.status}`);
        }

        const result = await response.json();
        const part = result?.candidates?.[0]?.content?.parts?.[0];
        const audioData = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;

        if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
            const rateMatch = mimeType.match(/rate=(\d+)/);
            const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000; 

            const pcmData = base64ToArrayBuffer(audioData);
            const pcm16 = new Int16Array(pcmData);
            const wavBlob = pcmToWav(pcm16, sampleRate);
            return URL.createObjectURL(wavBlob);
        } else {
            setErrorMessage("TTS Error: Could not generate valid audio data.");
            return null;
        }

    } catch (error) {
        console.error("TTS Fetch Error:", error);
        setErrorMessage(`TTS Generation failed: ${error.message}`);
        return null;
    }
};

// --- Firestore Collection Paths (using private user data model) ---
const SESSIONS_COLLECTION_PATH = `/artifacts/${APP_ID}/users`;
const MESSAGES_COLLECTION_PATH = (userId, sessionId) => 
    `/artifacts/${APP_ID}/users/${userId}/sessions/${sessionId}/messages`;


// --- UI Components (Defined locally for single-file mandate) ---

const Sidebar = React.memo(({ sessions, currentSessionId, switchSession, createNewSession, deleteSession, userId }) => {
    const displayUserId = userId ? `${userId.substring(0, 8)}...` : "N/A";
    
    return (
        <div className="w-full md:w-64 bg-gray-50 border-r border-gray-200 p-4 flex flex-col transition-all duration-300">
            <h2 className="text-xl font-bold text-gray-800 mb-4 flex items-center justify-between">
                Conversations
                <button
                    onClick={createNewSession}
                    className="p-2 bg-green-500 text-white rounded-full hover:bg-green-600 transition duration-150 shadow-md"
                    title="New Chat"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" />
                    </svg>
                </button>
            </h2>

            <div className="flex-1 overflow-y-auto space-y-2">
                {sessions.map((session) => (
                    <div
                        key={session.id}
                        className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition duration-150 ${session.id === currentSessionId ? 'bg-green-100 text-green-700 font-semibold' : 'bg-white text-gray-700 hover:bg-gray-100'}`}
                        onClick={() => switchSession(session.id)}
                    >
                        <span className="truncate flex-1">{session.name || "New Chat"}</span>
                        <button
                            onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                            className="text-red-500 p-1 hover:text-red-700 rounded-full transition duration-150 ml-2"
                            title="Delete Chat"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 100 2v6a1 1 0 100-2V8z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-200 text-sm text-gray-500">
                User ID: <span className="font-mono text-xs">{displayUserId}</span>
            </div>
        </div>
    );
});


// --- Main App Component ---

export default function App() {
    // --- Firebase State ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [sessions, setSessions] = useState([]);
    const [currentSessionId, setCurrentSessionId] = useState(null);

    // --- Chat State ---
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [isTyping, setIsTyping] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);
    const messageEndRef = useRef(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 768); 

    // --- TTS/STT State ---
    const [canSpeak, setCanSpeak] = useState(false);
    const [isListening, setIsListening] = useState(false); 
    const [lastBotMessage, setLastBotMessage] = useState(null);
    const recognitionRef = useRef(null); 


    // 1. Initialize Firebase and Authentication
    useEffect(() => {
        try {
            const app = initializeApp(FIREBASE_CONFIG);
            const firestore = getFirestore(app);
            const authentication = getAuth(app);

            setLogLevel('debug'); 
            setDb(firestore);
            setAuth(authentication);

            const unsubscribeAuth = onAuthStateChanged(authentication, async (user) => {
                if (!user) {
                    console.log("No user signed in. Attempting anonymous sign-in...");
                    try {
                        // Use anonymous sign-in for GitHub Pages deployment
                        await signInAnonymously(authentication);
                    } catch (e) {
                        console.error("Firebase Auth Error:", e);
                        setErrorMessage("Failed to authenticate with Firebase.");
                    }
                }
                setUserId(authentication.currentUser?.uid || crypto.randomUUID());
                setIsAuthReady(true);
            });

            return () => unsubscribeAuth();
        } catch (e) {
            console.error("Firebase Init Error:", e);
            setErrorMessage("Failed to initialize Firebase services.");
        }
    }, []); // Empty dependency array, runs once


    // 2. Setup Sessions Listener
    const createSession = useCallback(async () => {
        if (!db || !userId) return;

        try {
            const userSessionsRef = collection(db, SESSIONS_COLLECTION_PATH, userId, 'sessions');
            const newDocRef = doc(userSessionsRef);
            
            const placeholderName = `Chat ${sessions.length + 1}`; 

            await setDoc(newDocRef, {
                name: placeholderName,
                createdAt: serverTimestamp(),
            });

            setCurrentSessionId(newDocRef.id);
            if (window.innerWidth < 768) {
                setIsSidebarOpen(false); 
            }
        } catch (e) {
            console.error("Error creating new session:", e);
            setErrorMessage("Failed to create a new session.");
        }
    }, [db, userId, sessions.length]);

    useEffect(() => {
        if (!isAuthReady || !db || !userId) return;

        const userSessionsRef = collection(db, SESSIONS_COLLECTION_PATH, userId, 'sessions');
        const q = query(userSessionsRef, orderBy('createdAt', 'desc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const loadedSessions = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            setSessions(loadedSessions);

            if (loadedSessions.length === 0) {
                setTimeout(() => createSession(), 0); 
            } else if (!currentSessionId || !loadedSessions.find(s => s.id === currentSessionId)) {
                setCurrentSessionId(loadedSessions[0].id);
            }
        }, (error) => {
            console.error("Firestore Sessions Error:", error);
            setErrorMessage("Failed to fetch chat sessions.");
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, currentSessionId, createSession]);


    // 3. Setup Messages Listener (Current Session)
    useEffect(() => {
        if (!isAuthReady || !db || !userId || !currentSessionId) {
            setMessages([]); 
            return;
        }

        const messagesRef = collection(db, MESSAGES_COLLECTION_PATH(userId, currentSessionId));
        const q = query(messagesRef, orderBy('createdAt', 'asc'), limit(50));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const loadedMessages = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    sender: data.sender,
                    text: data.text,
                    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(),
                };
            });
            setMessages(loadedMessages);

            const lastBot = loadedMessages.slice().reverse().find(msg => msg.sender === 'bot');
            setLastBotMessage(lastBot);

        }, (error) => {
            console.error("Firestore Messages Error:", error);
            setErrorMessage("Failed to fetch chat messages.");
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, currentSessionId]);


    // 4. Scroll to bottom on new messages/typing
    useEffect(() => {
        messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, isTyping]);


    // 5. Check for TTS/STT capability and setup STT
    useEffect(() => {
        if ('speechSynthesis' in window && 'webkitSpeechRecognition' in window) {
            setCanSpeak(true);
        }

        if ('webkitSpeechRecognition' in window) {
            const recognitionInstance = new window.webkitSpeechRecognition();
            recognitionInstance.continuous = false;
            recognitionInstance.interimResults = false;
            recognitionInstance.lang = 'en-US';
            
            recognitionInstance.onend = () => setIsListening(false);
            recognitionInstance.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                setErrorMessage(`Speech recognition error: ${event.error}`);
                setIsListening(false);
            };

            recognitionRef.current = recognitionInstance;
        }

        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
                recognitionRef.current = null;
            }
        };
    }, []);

    // --- Firebase Actions ---

    const switchSession = useCallback((sessionId) => {
        setCurrentSessionId(sessionId);
        if (window.innerWidth < 768) {
            setIsSidebarOpen(false); 
        }
    }, []);

    const deleteSession = async (sessionId) => {
        if (!db || !userId) return;

        // Use a custom UI component for confirmation instead of window.confirm
        if (!window.confirm("Are you sure you want to delete this chat session and all its messages?")) {
            return;
        }

        try {
            const sessionDocRef = doc(db, SESSIONS_COLLECTION_PATH, userId, 'sessions', sessionId);
            const messagesRef = collection(db, MESSAGES_COLLECTION_PATH(userId, sessionId));
            
            const batch = writeBatch(db);

            const messageDocs = await getDocs(messagesRef);
            messageDocs.forEach(msgDoc => {
                batch.delete(msgDoc.ref);
            });
            
            batch.delete(sessionDocRef);

            await batch.commit();

            // Logic to switch to a new session after deletion
            if (currentSessionId === sessionId) {
                const remainingSessions = sessions.filter(s => s.id !== sessionId);
                if (remainingSessions.length > 0) {
                    setCurrentSessionId(remainingSessions[0].id);
                } else {
                    setCurrentSessionId(null);
                    setTimeout(() => createSession(), 100); 
                }
            }
        } catch (e) {
            console.error("Error deleting session:", e);
            setErrorMessage("Failed to delete the chat session.");
        }
    };
    
    // --- TTS/STT Handlers ---

    const handleSpeak = useCallback(async (text) => {
        if (!canSpeak || !text) return;

        setErrorMessage(null);

        const audioUrl = await ttsApiCall(text, setErrorMessage);
        if (audioUrl) {
            const audio = new Audio(audioUrl);
            audio.play();
        }
    }, [canSpeak]);

    const saveMessage = async (sender, text) => {
        if (!db || !userId || !currentSessionId || !text) return;

        try {
            const messagesRef = collection(db, MESSAGES_COLLECTION_PATH(userId, currentSessionId));
            await addDoc(messagesRef, {
                sender: sender,
                text: text,
                createdAt: serverTimestamp(),
            });
        } catch (e) {
            console.error("Error saving message:", e);
            setErrorMessage("Failed to save message to database.");
        }
    };
const handleSend = useCallback(async (transcript = null) => {
    let textToSend = (transcript || input).trim();

    if (!textToSend) return;

    // Temporarily disable ONLY after validating text
    setInput("");

    // Do not block on isTyping — allow sending next prompt while model is thinking
    // (This solves the “need to tap many times” bug)
    if (isTyping) {
        console.warn("Previous message still generating, sending anyway...");
    }

    setErrorMessage(null);
    setIsTyping(true);

    await saveMessage("user", textToSend);

    let accumulatedBotText = "";
    const historyForAI = messages.map(msg => ({ sender: msg.sender, text: msg.text }));
    const stream = askAIStream(textToSend, historyForAI);

    const tempBotId = uuidv4();
    setMessages(prev => [...prev, { id: tempBotId, sender: "bot", text: "" }]);

    try {
        for await (const chunk of stream) {
            accumulatedBotText += chunk;

            setMessages(prev =>
                prev.map(msg =>
                    msg.id === tempBotId ? { ...msg, text: accumulatedBotText } : msg
                )
            );
        }
    } catch (err) {
        console.error("Stream error:", err);
        accumulatedBotText = "Sorry, an error occurred.";
    }

    setIsTyping(false);

    const sessionDocRef = doc(db, SESSIONS_COLLECTION_PATH, userId, 'sessions', currentSessionId);

    if (messages.length === 0) {
        const sessionName = textToSend.substring(0, 30) + (textToSend.length > 30 ? "..." : "");
        await setDoc(sessionDocRef, { name: sessionName }, { merge: true });
    }

    await saveMessage("bot", accumulatedBotText);

}, [input, isTyping, currentSessionId, db, userId, messages]);



    const startListening = useCallback(() => {
        if (isTyping || !recognitionRef.current) return;
        
        setErrorMessage(null);
        
        const recognitionInstance = recognitionRef.current;
        
        // This is where we handle the result of the speech recognition
        recognitionInstance.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            setInput(transcript);
            recognitionInstance.stop(); 
            // Call handleSend with the transcribed text
            handleSend(transcript); 
        };

        try {
            recognitionInstance.start();
            setIsListening(true);
        } catch (e) {
            if (e.name !== 'InvalidStateError') { 
                console.error("STT Start Error:", e);
                setErrorMessage("Speech recognition failed to start. Browser support required.");
                setIsListening(false);
            }
        }
    }, [isTyping, handleSend, setInput, setIsListening]); 


    // --- Render Logic ---
    if (!isAuthReady) {
        return (
            <div className="flex justify-center items-center min-h-screen text-gray-600 bg-gray-100">
                <div className="p-6 bg-white rounded-xl shadow-lg">
                    <p>Loading application and authenticating...</p>
                </div>
            </div>
        );
    }
    
    // Header component
    const Header = () => (
        <div className="p-4 bg-green-600 text-white shadow-md flex items-center justify-between">
            <button 
                className="md:hidden p-1 rounded-md hover:bg-green-700 transition"
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                title="Toggle Sidebar"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
                </svg>
            </button>
            <h1 className="text-xl font-bold flex-1 text-center md:text-left">
                Mene AI Chatbot
            </h1>
            <span className="hidden md:block text-sm opacity-80 bg-green-700 px-3 py-1 rounded-full">
                Session: {sessions.find(s => s.id === currentSessionId)?.name || "New Chat"}
            </span>
            <div className="hidden md:block text-xs font-mono opacity-60 ml-4">
                App ID: {APP_ID.substring(0, 8)}...
            </div>
        </div>
    );

    // Main Chat Content
    const chatContent = (
        <div className="flex-1 flex flex-col min-w-0 bg-white">
            <Header />

            {errorMessage && (
                <div className="p-3 bg-red-100 text-red-700 text-sm text-center font-medium border-l-4 border-red-500">
                    {errorMessage}
                </div>
            )}

            <div className="flex-1 p-4 space-y-4 overflow-y-auto custom-scrollbar">
                {messages.map((msg) => (
                    <div 
                        key={msg.id} 
                        className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
                    >
                        <div
                            className={`max-w-xs md:max-w-md lg:max-w-lg p-3 rounded-xl shadow-md text-sm ${
                                msg.sender === "user"
                                    ? "bg-blue-500 text-white rounded-br-none"
                                    : "bg-gray-200 text-gray-800 rounded-tl-none"
                            }`}
                            onClick={msg.sender === "bot" && canSpeak ? () => handleSpeak(msg.text) : null}
                            style={msg.sender === "bot" && canSpeak ? {cursor: 'pointer'} : {}}
                            title={msg.sender === "bot" && canSpeak ? "Click to hear this message" : null}
                        >
                            {msg.text}
                        </div>
                    </div>
                ))}

                {isTyping && (
                    <div className="flex justify-start">
                        <div className="max-w-xs p-3 rounded-xl bg-gray-100 text-gray-500 italic text-sm shadow-sm">
                            Mene is generating...
                        </div>
                    </div>
                )}

                <div ref={messageEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-3 border-t border-gray-200 flex items-center space-x-2 bg-gray-50">
                {/* STT Button */}
                <button 
                    className={`p-3 rounded-full transition duration-150 shadow-md ${
                        isListening 
                            ? 'bg-red-500 text-white animate-pulse' 
                            : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
                    }`}
                    onClick={startListening}
                    disabled={isTyping || !canSpeak} // Disable if STT/TTS not supported
                    title={isListening ? "Listening..." : "Start voice input (STT)"}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4z" />
                        <path d="M5.5 9.5a.5.5 0 011 0v4a.5.5 0 01-1 0v-4zM13.5 9.5a.5.5 0 011 0v4a.5.5 0 01-1 0v-4z" />
                        <path d="M10 18a.75.75 0 01-.75-.75V15a.75.75 0 011.5 0v2.25A.75.75 0 0110 18zm6.5-6.5a.5.5 0 01-1 0v-4a.5.5 0 011 0v4zM3.5 11.5a.5.5 0 011 0v-4a.5.5 0 01-1 0v4z" />
                        <path d="M5 9.75a.75.75 0 01.75-.75h8.5a.75.75 0 010 1.5H5.75A.75.75 0 015 9.75z" />
                        <path d="M15 11a1 1 0 011 1v2a4 4 0 01-8 0v-2a1 1 0 011-1h6z" />
                    </svg>
                </button>

                {/* Text Input */}
                    <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.keyCode === 13) {
                    e.preventDefault();
                    handleSend();
                }
            }}
            placeholder="Ask Mene anything..."
            className="flex-1 p-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-green-500"
            />


                {/* TTS Button */}
                <button 
                    className={`p-3 rounded-full transition duration-150 shadow-md ${
                        canSpeak && !isTyping && lastBotMessage
                            ? 'bg-green-500 text-white hover:bg-green-600'
                            : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    }`}
                    onClick={() => handleSpeak(lastBotMessage?.text)}
                    disabled={isTyping || !canSpeak || !lastBotMessage}
                    title="Read last bot message aloud (TTS)"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M9.383 3.003c.125-.466.52-.803.955-.803h.305c.435 0 .83.337.955.803l.36 1.353a1.5 1.5 0 001.037.989l.254.053c1.685.356 2.5 1.776 2.5 3.328v2.96c0 1.552-.815 2.972-2.5 3.328l-.254.053a1.5 1.5 0 00-1.037.989l-.36 1.353c-.125.466-.52.803-.955.803h-.305c-.435 0-.83-.337-.955.803l-.36-1.353a1.5 1.5 0 00-1.037-.989l-.254-.053c-1.685-.356-2.5-1.776-2.5-3.328v-2.96c0-1.552.815-2.972 2.5-3.328l.254-.053a1.5 1.5 0 001.037-.989l.36-1.353zM10 7a1 1 0 100 2 1 1 0 000-2zm0 4a1 1 0 100 2 1 1 0 000-2z" />
                    </svg>
                </button>

                {/* Send Button */}
                <button 
                    className={`p-3 rounded-full transition duration-150 shadow-md ${
                        isTyping || !input.trim()
                            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                            : 'bg-green-500 text-white hover:bg-green-600'
                    }`}
                    onClick={() => handleSend()} 
                    disabled={isTyping || !input.trim()}
                    title="Send Message"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l4.47-1.405 6.447 3.376a1 1 0 00.999 0l6.447-3.376 4.47 1.405a1 1 0 001.169-1.409l-7-14z" />
                    </svg>
                </button>
            </div>
        </div>
    );

    // Final Application Layout (Desktop/Mobile Responsive)
    return (
        <div className="flex flex-col min-h-screen w-full bg-gray-100 font-inter">

            {/* Tailwind CSS Script for Inter Font and General Styling */}
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                            {`
                            html, body, #root {
                height: 100%;
                margin: 0;
                padding: 0;
            }

                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
                    body { font-family: 'Inter', sans-serif; }
                    .custom-scrollbar::-webkit-scrollbar { width: 8px; }
                    .custom-scrollbar::-webkit-scrollbar-track { background: #f1f1f1; }
                    .custom-scrollbar::-webkit-scrollbar-thumb { background: #ccc; border-radius: 10px; }
                    .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #999; }
                `}
            </style>
            
            <div className="w-full h-screen md:w-full md:max-w-6xl md:h-[90vh] flex bg-white md:rounded-xl shadow-2xl overflow-hidden transition-all duration-300">
                
                {/* Sidebar (Conversations Menu) */}
                <div 
                    className={`fixed inset-0 z-40 md:static md:z-auto ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 transition-transform duration-300 w-64 flex-shrink-0`}
                >
                    <Sidebar 
                        sessions={sessions}
                        currentSessionId={currentSessionId}
                        switchSession={switchSession}
                        createNewSession={createSession}
                        deleteSession={deleteSession}
                        userId={userId}
                    />
                    {isSidebarOpen && window.innerWidth < 768 && (
                        <div 
                            className="absolute inset-0 bg-black opacity-50 md:hidden z-30" 
                            onClick={() => setIsSidebarOpen(false)}
                        ></div>
                    )}
                </div>

                {/* Main Chat Area */}
                <div className="flex-1 flex flex-col min-w-0 z-10">
                    {chatContent}
                </div>
            </div>
        </div>
    );
}