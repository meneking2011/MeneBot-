import React, { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from 'uuid';

// --- FIREBASE IMPORTS ---
import { 
    initializeApp 
} from 'firebase/app';
import { 
    getAuth, 
    signInAnonymously, 
    signInWithCustomToken, 
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
    where,
    writeBatch,
    getDocs,
    setDoc
} from 'firebase/firestore';


// --- ENVIRONMENT VARIABLE HANDLING ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// --- API and TTS Helper Functions ---

const getApiKey = () => {
    // 1. Check for the secure, environment-provided key first
    if (typeof __api_key !== 'undefined') { 
        return __api_key; 
    }
    // 2. Use the key provided by the user as a fallback
    return 'AIzaSyD0fDB4XPYTSONxvbLTUCLznwzLWWV11ys'; 
};

const GEMINI_API_KEY = getApiKey();
const MODEL_NAME = 'gemini-2.5-flash-preview-09-2025';
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

const withExponentialBackoff = async (fn, maxRetries = 5) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries - 1 || !(error.message.includes('429') || error.message.includes('500') || error.message.includes('Failed to fetch'))) {
                throw error;
            }
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

function askAIStream(chatHistory, systemInstruction) {
    let fullResponse = null;
    let chunks = [];
    let chunkIndex = 0;
    const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

    return {
        async next() {
            try {
                if (fullResponse === null) {
                    const fetchContent = async () => {
                        const response = await fetch(API_ENDPOINT, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: chatHistory,
                                systemInstruction: { parts: [{ text: systemInstruction }] },
                                tools: [{ google_search: {} }] 
                            })
                        });
                        if (!response.ok) {
                            const errorDetails = await response.json().catch(() => ({ error: { message: "Unknown error format" } }));
                            throw new Error(`${response.status} ${response.statusText}: ${errorDetails.error.message}`); 
                        }
                        const data = await response.json();
                        fullResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received from AI.";
                        chunks = fullResponse.split(/(\s+)/).filter(c => c.length > 0); 
                    };
                    await withExponentialBackoff(fetchContent);
                }
                if (chunkIndex >= chunks.length) { return { done: true }; }
                await new Promise((r) => setTimeout(r, 20));
                const chunk = chunks[chunkIndex++];
                return { value: chunk, done: false };
            } catch (error) {
                console.error("Gemini API Error:", error);
                return { value: `ERROR: Failed to connect to AI. Details: ${error.message}`, done: true };
            }
        },
        [Symbol.asyncIterator]() { return this; }
    };
}

const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

const pcmToWav = (pcm16, sampleRate) => {
    const numChannels = 1;
    const numSamples = pcm16.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    view.setUint32(0, 0x52494646, false); 
    view.setUint32(4, 36 + numSamples * 2, true);
    view.setUint32(8, 0x57415645, false);
    view.setUint32(12, 0x666d7420, false); 
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); 
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false);
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        view.setInt16(44 + i * 2, pcm16[i], true);
    }
    return new Blob([view], { type: 'audio/wav' });
};

let audioContext = null;
let audioSource = null;

const fetchTtsAudio = async (text) => {
    const TTS_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const payload = {
        contents: [{ parts: [{ text: text }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
        },
        model: TTS_MODEL
    };

    const fetchTts = async () => {
        const response = await fetch(TTS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`TTS API failed: ${response.status} ${response.statusText}`);
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
        }
        throw new Error("Invalid TTS response format.");
    };

    return withExponentialBackoff(fetchTts);
};


// --- SESSION MANAGEMENT COMPONENT (Sidebar) ---

const Sidebar = ({ sessions, currentSessionId, switchSession, createNewSession, deleteSession }) => (
    <div className="w-full md:w-64 bg-gray-900 text-white flex-shrink-0 flex flex-col p-4 shadow-xl">
        <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-emerald-400">Conversations</h2>
            <button
                onClick={() => createNewSession(null)}
                className="p-2 bg-emerald-600 rounded-lg shadow-md hover:bg-emerald-500 transition-colors flex items-center text-sm font-medium"
                title="Start a New Chat"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Chat
            </button>
        </div>
        
        <div className="space-y-2 overflow-y-auto flex-1 pr-2">
            {sessions.map((session) => (
                <div 
                    key={session.id} 
                    className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
                        session.id === currentSessionId ? "bg-emerald-700/80 ring-2 ring-emerald-500" : "bg-gray-800 hover:bg-gray-700"
                    }`}
                >
                    <span 
                        className="truncate text-sm font-medium flex-1"
                        onClick={() => switchSession(session.id)}
                        title={session.title}
                    >
                        {session.title}
                    </span>
                    <button
                        onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                        className="ml-2 text-gray-400 hover:text-red-400 p-1 rounded-full transition-colors"
                        title="Delete Chat"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            ))}
        </div>
        {!sessions.length && <p className="text-gray-500 text-center text-sm mt-4">No chats yet. Start a new one!</p>}
    </div>
);


// --- MAIN APP COMPONENT ---

export default function App() {
    const [sessions, setSessions] = useState([]);
    const [currentSessionId, setCurrentSessionId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [isTyping, setIsTyping] = useState(false);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [userId, setUserId] = useState(null);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [error, setError] = useState(null);
    const messageEndRef = useRef(null);
    const [canSpeak, setCanSpeak] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 768);
    
    const lastBotMessage = messages.slice().reverse().find(msg => msg.sender === 'bot');

    const SYSTEM_INSTRUCTION = "You are Mene Bot, an expert, cheerful, and helpful AI assistant. Keep your responses concise and highly informative. Use Google Search grounding for up-to-date facts when necessary.";

    // Helper for getting collection path based on user ID
    const getBasePath = useCallback((uid) => `/artifacts/${appId}/users/${uid}`, []);

    // --- Firebase Initialization and Auth ---
    useEffect(() => {
        if (!firebaseConfig) {
            setError("Firebase configuration is missing.");
            return;
        }
        try {
            setLogLevel('debug');
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const firebaseAuth = getAuth(app);
            setDb(firestore);
            setAuth(firebaseAuth);

            onAuthStateChanged(firebaseAuth, async (user) => {
                if (!user) {
                    if (initialAuthToken) {
                        try {
                            await signInWithCustomToken(firebaseAuth, initialAuthToken);
                        } catch (e) {
                            console.error("Custom token sign-in failed, signing in anonymously:", e);
                            await signInAnonymously(firebaseAuth);
                        }
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                }
                
                // IMPORTANT FIX: Set userId strictly based on the authenticated user.
                const currentUser = firebaseAuth.currentUser;
                if (currentUser) {
                    setUserId(currentUser.uid);
                    setIsAuthReady(true);
                } else {
                    setUserId(null);
                    setIsAuthReady(true); // Still ready, but anonymous or failed sign-in
                }
            });
        } catch (e) {
            console.error("Firebase initialization failed:", e);
            setError(`Firebase initialization failed: ${e.message}`);
        }
    }, []);

    // --- Message Saving Function (moved inside App to access userId reliably) ---
    const saveMessage = useCallback(async (sender, text, sessionId) => {
        // Strict guard check for authentication completion
        if (!db || !userId || !sessionId) {
            console.error("Error saving message: Missing DB, UserID, or SessionID.");
            throw new Error("Cannot save message: Authentication not complete or session missing.");
        }
        
        const basePath = getBasePath(userId); // Uses the authenticated userId for the path
        
        try {
            await addDoc(collection(db, basePath, 'messages'), {
                sessionId,
                sender,
                text,
                userId: userId, // Record the actual UID of the owner
                timestamp: serverTimestamp()
            });
        } catch (e) {
            console.error("Error saving message:", e);
            throw new Error(`Could not save message to database: ${e.message}`);
        }
    }, [db, userId, getBasePath]);


    // --- SESSION MANAGEMENT FUNCTIONS (Wrapped in useCallback) ---

    const createSession = useCallback(async (initialTitle = null) => {
        if (!db || !userId) return; // Guard
        const basePath = getBasePath(userId);
        const sessionsRef = collection(db, basePath, 'sessions');
        
        try {
            const newSession = {
                title: initialTitle || ("New Chat " + new Date().toLocaleTimeString()),
                createdAt: serverTimestamp(),
            };
            const docRef = await addDoc(sessionsRef, newSession);
            setCurrentSessionId(docRef.id);
            if (window.innerWidth < 768) {
                setIsSidebarOpen(false);
            }
        } catch (e) {
            console.error("Error creating session:", e);
            setError(`Could not create new session: ${e.message}`);
        }
    }, [db, userId, getBasePath]);
    
    const switchSession = (id) => {
        setCurrentSessionId(id);
        if (window.innerWidth < 768) {
            setIsSidebarOpen(false);
        }
    };

    const deleteSession = async (sessionIdToDelete) => {
        if (!db || !userId) return; // Guard
        const basePath = getBasePath(userId);
        const sessionDocRef = doc(db, basePath, 'sessions', sessionIdToDelete);
        const messagesRef = collection(db, basePath, 'messages');
        
        const batch = writeBatch(db);

        try {
            const messagesQuery = query(messagesRef, where('sessionId', '==', sessionIdToDelete));
            const messagesSnapshot = await withExponentialBackoff(() => getDocs(messagesQuery));
            
            messagesSnapshot.forEach((msgDoc) => {
                batch.delete(msgDoc.ref);
            });
            
            batch.delete(sessionDocRef);
            
            await batch.commit();

            if (sessionIdToDelete === currentSessionId) {
                const remainingSessions = sessions.filter(s => s.id !== sessionIdToDelete);
                if (remainingSessions.length > 0) {
                    setCurrentSessionId(remainingSessions[0].id);
                } else {
                    setCurrentSessionId(null);
                    setMessages([]);
                }
            }
        } catch (e) {
            console.error("Error deleting session and messages:", e);
            setError(`Could not delete session: ${e.message}`);
        }
    };


    // --- Firestore Realtime Listeners ---

    // Listener 1: Fetch Sessions
    useEffect(() => {
        if (!isAuthReady || !db || !userId) return; // Strict guard

        const basePath = getBasePath(userId);
        const q = query(collection(db, basePath, 'sessions'), orderBy('createdAt', 'desc'));

        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            const fetchedSessions = [];
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                fetchedSessions.push({ 
                    id: doc.id,
                    title: data.title || `Chat ${doc.id.substring(0, 5)}`,
                    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(),
                });
            });
            setSessions(fetchedSessions);

            // --- AUTO-START LOGIC ---
            if (fetchedSessions.length > 0 && !currentSessionId) {
                setCurrentSessionId(fetchedSessions[0].id);
            } else if (fetchedSessions.length === 0 && userId) { // Check userId before trying to create
                setTimeout(() => {
                    if (userId && db) { 
                         createSession('Auto-Start Chat'); 
                    }
                }, 100);
            }

        }, (err) => {
            console.error("Firestore session subscription failed:", err);
            setError(`Failed to load sessions: ${err.message}`);
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, currentSessionId, createSession, getBasePath]); 

    // Listener 2: Fetch Messages for Current Session
    useEffect(() => {
        if (!isAuthReady || !db || !userId || !currentSessionId) {
            setMessages([]);
            return;
        }

        const basePath = getBasePath(userId);
        
        const q = query(
            collection(db, basePath, 'messages'),
            where('sessionId', '==', currentSessionId), 
            limit(100)
        );

        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            let fetchedMessages = [];
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                fetchedMessages.push({ 
                    id: doc.id,
                    sender: data.sender || 'bot',
                    text: data.text || '', 
                    userId: data.userId,
                    timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : new Date(),
                });
            });
            
            // Client-side sorting by timestamp (ascending)
            fetchedMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

            setMessages(fetchedMessages);
        }, (err) => {
            console.error("Firestore message subscription failed:", err);
            setError(`Failed to load messages: ${err.message}`);
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, currentSessionId, getBasePath]);

    // --- Auto Scroll & TTS Check ---
    useEffect(() => {
        if (messageEndRef.current) {
            messageEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [messages]);

    useEffect(() => {
        setCanSpeak(typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined');
        if (!audioContext && canSpeak) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    }, [canSpeak]);
    
    // --- Core Logic Functions ---
    
    const handleSpeak = useCallback(async (text) => {
        if (!canSpeak || !text || isTyping) return;
        if (audioSource) { audioSource.stop(); audioSource = null; }
        try {
            const audioUrl = await fetchTtsAudio(text);
            const audio = new Audio(audioUrl);
            audio.play();
            audio.onended = () => { URL.revokeObjectURL(audioUrl); };
        } catch (e) {
            console.error("TTS playback failed:", e);
            setError(`TTS Error: ${e.message}`);
        }
    }, [canSpeak, isTyping]);


    const handleSend = async () => {
        if (!input.trim() || isTyping || !userId || !currentSessionId) {
            if (!currentSessionId) setError("Please start a new chat session first or wait for the auto-start.");
            return;
        }

        const userInput = input;
        setInput("");
        setIsTyping(true);
        setError(null);
        
        // 1. Get the current chat history for context
        const chatHistoryForAPI = messages
            .filter(msg => !msg.text.startsWith("ERROR")) 
            .map(msg => ({ 
                role: msg.sender === 'user' ? 'user' : 'model', 
                parts: [{ text: msg.text }] 
            }));

        chatHistoryForAPI.push({ role: 'user', parts: [{ text: userInput }] });
        
        try {
            // 2. Optimistically add the user message to Firestore
            await saveMessage("user", userInput, currentSessionId);
        } catch (e) {
            setIsTyping(false);
            setError(e.message);
            return;
        }

        // 3. Add a local placeholder message for streaming visualization
        let botMessageId = uuidv4();
        setMessages((prev) => [...prev, { id: botMessageId, sender: "bot", text: "", userId: 'bot-temp', timestamp: new Date(), sessionId: currentSessionId }]);
        
        let botText = "";
        try {
            const generator = askAIStream(chatHistoryForAPI, SYSTEM_INSTRUCTION);
            let next = await generator.next();

            while (!next.done) {
                botText += next.value;
                // Update the last message's text in the state to simulate streaming
                setMessages((prev) => {
                    const updated = [...prev];
                    const lastIndex = updated.length - 1;
                    if (updated[lastIndex]?.id === botMessageId) {
                         updated[lastIndex].text = botText;
                    }
                    return updated;
                });
                next = await generator.next();
            }

            // 4. Save the final bot message to Firestore (using authenticated userId for path)
            await saveMessage("bot", botText, currentSessionId);
            
            // 5. Update session title if it's the first message or if title is the generic auto-start title
            const currentSession = sessions.find(s => s.id === currentSessionId);
            if (db && userId && (!currentSession || currentSession.title.startsWith("Auto-Start Chat"))) {
                const firstWords = userInput.split(/\s+/).slice(0, 5).join(" ") + "...";
                const sessionDocRef = doc(db, getBasePath(userId), 'sessions', currentSessionId);
                await withExponentialBackoff(() => setDoc(sessionDocRef, { title: firstWords }, { merge: true }));
            }
            
        } catch (e) {
            console.error("AI interaction failed:", e);
            botText = `ERROR: Failed to get response from AI. Details: ${e.message}`;
            setError(botText);
            // Save the error message so it's persistent (still uses correct userId for path)
            await saveMessage("bot", botText, currentSessionId);
        }
        
        // 6. Cleanup: Remove the local placeholder.
        setMessages(prev => prev.filter(msg => msg.id !== botMessageId));
        setIsTyping(false);
    };

    const startListening = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setError("Voice typing is not supported by your browser.");
            return;
        }
        try {
            const recognizer = new SpeechRecognition();
            recognizer.lang = "en-US";
            recognizer.continuous = false;
            recognizer.interimResults = false;
            
            recognizer.onresult = (e) => {
                const transcript = e.results[0][0].transcript;
                setInput(transcript);
            };

            recognizer.onerror = (e) => {
                 console.error("Speech recognition error:", e.error);
                 setError(`Voice input error: ${e.error}`);
            };

            recognizer.onstart = () => { setError("Listening... Speak now."); };
            recognizer.onend = () => { if (error === "Listening... Speak now.") setError(null); };

            recognizer.start();
        } catch (e) {
            console.error("Failed to start speech recognition:", e);
            setError(`Could not start voice input: ${e.message}`);
        }
    };


    // --- UI RENDER ---
    const chatContent = (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="bg-emerald-600 text-white p-4 flex justify-between items-center shadow-lg">
                <div className="flex items-center">
                    <button 
                        className="md:hidden p-1 mr-2 rounded-md hover:bg-emerald-500 transition-colors"
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        title="Toggle Conversations Menu"
                    >
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                        </svg>
                    </button>
                    <h1 className="text-xl font-bold flex items-center">
                        <span className="text-2xl mr-2">🤖</span> Mene Bot
                    </h1>
                </div>
                {isAuthReady ? (
                    <div className="text-xs bg-emerald-700/70 py-1 px-3 rounded-full opacity-80 cursor-default truncate" title={`Current User ID: ${userId}`}>
                        User: {userId ? `${userId.substring(0, 5)}...` : 'Anon'}
                    </div>
                ) : (
                    <div className="text-xs bg-emerald-700/70 py-1 px-3 rounded-full">Connecting...</div>
                )}
            </div>

            {/* Error Message Display */}
            {error && (
                <p className="p-3 bg-red-100 text-red-700 border-l-4 border-red-500 text-sm font-medium transition-all duration-300">
                    {error}
                </p>
            )}

            {/* Messages Area */}
            <div className="flex-1 p-4 overflow-y-auto bg-gray-50 space-y-4">
                {!isAuthReady && (
                    <div className="text-center text-gray-500 italic p-10">
                        Establishing secure connection to Firebase and Gemini...
                    </div>
                )}
                {!currentSessionId && isAuthReady && (
                    <div className="text-center text-gray-500 p-10">
                        {sessions.length === 0 
                            ? "Starting your first chat... hold on a moment."
                            : "Select a chat from the sidebar to continue."
                        }
                    </div>
                )}
                
                {messages.map((msg) => (
                    <div 
                        key={msg.id || msg.timestamp.getTime()} 
                        className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
                    >
                        <div 
                            className={`max-w-[80%] p-3 rounded-xl shadow-md transition-all duration-200 ${
                                msg.sender === "user"
                                    ? "bg-blue-600 text-white rounded-br-none"
                                    : "bg-emerald-500 text-white rounded-tl-none"
                            } ${msg.text.startsWith("ERROR") ? "bg-red-500/80" : ""}`}
                            onClick={msg.sender === "bot" && canSpeak ? () => handleSpeak(msg.text) : null}
                            style={msg.sender === "bot" && canSpeak ? {cursor: 'pointer'} : {}}
                            title={msg.sender === "bot" && canSpeak ? "Click to hear this message" : null}
                        >
                            <p className="text-xs opacity-70 mb-1">{msg.sender === 'bot' ? 'MeneBot' : msg.userId.substring(0, 8)}</p>
                            <span className="whitespace-pre-wrap">{msg.text || "Message content unavailable"}</span>
                        </div>
                    </div>
                ))}

                {isTyping && (
                    <div className="flex justify-start">
                        <div className="max-w-[80%] p-3 rounded-xl shadow-md bg-gray-300 text-gray-700 rounded-tl-none italic">
                            Bot is generating...
                        </div>
                    </div>
                )}

                <div ref={messageEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 bg-white border-t border-gray-200 flex space-x-2 flex-shrink-0">
                <button 
                    className="p-3 rounded-full bg-indigo-500 text-white shadow-lg hover:bg-indigo-600 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed" 
                    onClick={startListening}
                    disabled={isTyping || !isAuthReady || !currentSessionId}
                    title="Start Voice Input"
                >
                    🎤
                </button>

                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSend()}
                    placeholder={currentSessionId ? "Ask Mene anything..." : "Start a new chat first..."}
                    disabled={isTyping || !isAuthReady || !currentSessionId}
                    className="flex-1 p-3 border border-gray-300 rounded-full focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition-all duration-200"
                />
                
                <button 
                    className="p-3 rounded-full bg-emerald-500 text-white shadow-lg hover:bg-emerald-600 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                    onClick={() => handleSpeak(lastBotMessage?.text)}
                    disabled={isTyping || !canSpeak || !lastBotMessage}
                    title="Read last bot message aloud"
                >
                    🔊
                </button>

                <button 
                    onClick={handleSend} 
                    disabled={isTyping || !input.trim() || !isAuthReady || !currentSessionId || !userId}
                    className="p-3 rounded-full bg-emerald-600 text-white font-semibold shadow-lg hover:bg-emerald-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                    Send
                </button>
            </div>
        </div>
    );

    return (
        <div className="flex flex-col md:flex-row items-center justify-center min-h-screen bg-gray-100 p-4 font-inter">
            <div className="w-full max-w-6xl h-[90vh] flex bg-white rounded-xl shadow-2xl overflow-hidden transition-all duration-300">
                
                {/* Sidebar (Conversations Menu) */}
                <div className={`fixed inset-0 z-40 md:static md:z-auto ${isSidebarOpen ? 'block' : 'hidden'} md:block transition-transform duration-300`}>
                    <Sidebar 
                        sessions={sessions}
                        currentSessionId={currentSessionId}
                        switchSession={switchSession}
                        createNewSession={createSession}
                        deleteSession={deleteSession}
                    />
                    {/* Overlay for mobile view */}
                    {isSidebarOpen && window.innerWidth < 768 && (
                        <div 
                            className="absolute inset-0 bg-black opacity-50 md:hidden" 
                            onClick={() => setIsSidebarOpen(false)}
                        ></div>
                    )}
                </div>

                {/* Main Chat Area */}
                <div className="flex-1 flex flex-col min-w-0">
                    {chatContent}
                </div>
            </div>
        </div>
    );
}
