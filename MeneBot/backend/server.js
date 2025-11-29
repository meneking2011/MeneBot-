// Install required packages: npm install express sqlite3 cors

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors'); 

const app = express();
// NOTE: Change the PORT if necessary, but 3001 is standard for development backends
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
const DB_PATH = './chat_memory.db';

// --- Configuration Variables ---
// ⚠️ INPUT REQUIRED: Replace with your actual Gemini API Key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const MODEL_NAME = "gemini-2.5-flash";
const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;


// Middleware Setup
app.use(cors());
app.use(express.json()); 

// --- Database Connection and Initialization ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("Error opening database " + err.message);
    } else {
        console.log('Connected to the SQLite database.');
        // Initialize tables with "ON DELETE CASCADE" for messages
        db.run(`CREATE TABLE IF NOT EXISTS chats (
            chat_id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            message_id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            sender TEXT NOT NULL, 
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats (chat_id) ON DELETE CASCADE
        )`);
        console.log('Database tables ensured.');
    }
});

// --- UTILITY: Gemini AI Call ---
// Simplified from the streaming version in the original code, now handled on the backend
async function askAI(userText, history) {
    // We only check if the key is missing or empty. The host (Render) provides the key.
if (!GEMINI_API_KEY) {
    // This will error out if Render fails to provide the environment variable
    throw new Error("Gemini API Key is missing. Ensure the GEMINI_API_KEY environment variable is set.");
}

    const formattedHistory = history.map((msg) => ({
        role: msg.sender === "user" ? "user" : "model",
        parts: [{ text: msg.content }], // Use 'content' field from DB
    }));

    const payload = {
        contents: [
            ...formattedHistory,
            { role: "user", parts: [{ text: userText }] },
        ],
        systemInstruction: {
            parts: [
                { text: "You are Mene. Keep responses short and friendly." },
            ],
        },
    };

    try {
        const response = await fetch(`${API_ENDPOINT}?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Error ${response.status}: ${errorData?.error?.message || "Unknown"}`);
        }

        const data = await response.json();
        const botResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || "I'm sorry, I couldn't generate a response.";
        return botResponse;

    } catch (error) {
        console.error("Gemini API call failed:", error.message);
        return "Sorry, I ran into a technical error.";
    }
}


// --- API Endpoints ---

// GET /api/chats - Get all chat sessions
app.get('/api/chats', (req, res) => {
    // NOTE: In a production app, you'd filter by user_id
    const sql = 'SELECT chat_id as id, title as name FROM chats ORDER BY created_at DESC';
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ data: rows });
    });
});

// POST /api/chats - Create a new chat session
app.post('/api/chats', (req, res) => {
    const title = req.body.title || 'New Chat';
    const sql = 'INSERT INTO chats (title) VALUES (?)';
    db.run(sql, [title], function (err) {
        if (err) {
            res.status(400).json({ error: err.message });
            return;
        }
        res.json({
            id: this.lastID,
            name: title,
        });
    });
});

// DELETE /api/chats/:id - Delete a chat session
app.delete('/api/chats/:id', (req, res) => {
    const chatId = req.params.id;
    const sql = 'DELETE FROM chats WHERE chat_id = ?';
    db.run(sql, chatId, function (err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (this.changes === 0) {
            res.status(404).json({ message: 'Chat not found' });
            return;
        }
        res.json({ message: `Chat deleted successfully` });
    });
});

// GET /api/chats/:id/messages - Get all messages for a specific chat
app.get('/api/chats/:id/messages', (req, res) => {
    const chatId = req.params.id;
    // We select all fields and rename 'content' to 'text' and 'chat_id' to 'sessionId' to match frontend needs
    const sql = 'SELECT message_id as id, sender, content as text FROM messages WHERE chat_id = ? ORDER BY timestamp ASC';
    db.all(sql, chatId, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ data: rows });
    });
});

// POST /api/chats/:id/messages - Send a user message and get a bot response
app.post('/api/chats/:id/messages', async (req, res) => {
    const chatId = req.params.id;
    const { content } = req.body; // user's message

    if (!content) {
        res.status(400).json({ error: 'Missing message content' });
        return;
    }

    // 1. Fetch current history to provide memory to the AI
    const historySql = 'SELECT sender, content FROM messages WHERE chat_id = ? ORDER BY timestamp ASC';
    db.all(historySql, chatId, async (err, history) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        // 2. Save the user's message
        const userMsgSql = 'INSERT INTO messages (chat_id, sender, content) VALUES (?, ?, ?)';
        db.run(userMsgSql, [chatId, 'user', content], async function (userErr) {
            if (userErr) {
                res.status(400).json({ error: userErr.message });
                return;
            }

            // 3. Call the AI with the entire history (including the new user message)
            const fullHistory = [...history, { sender: 'user', content: content }];
            const botResponseText = await askAI(content, fullHistory);

            // 4. Save the bot's response
            const botMsgSql = 'INSERT INTO messages (chat_id, sender, content) VALUES (?, ?, ?)';
            db.run(botMsgSql, [chatId, 'bot', botResponseText], function (botErr) {
                if (botErr) {
                    // Log error but still succeed if user message saved
                    console.error("Failed to save bot response:", botErr.message);
                }
                
                // 5. Respond to the frontend with the bot's message
                res.json({
                    message: 'Message exchange complete',
                    botResponse: {
                        id: this.lastID, // The ID of the bot message
                        sender: 'bot',
                        text: botResponseText,
                    }
                });
            });
        });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`\n➡️ Start the backend by running: node server.js`);
});