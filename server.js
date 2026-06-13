require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Global anti-crash error handler for body-parser payload limits
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Image file is too large! Please upload a file smaller than 50MB.' });
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON payload received.' });
    }
    next(err);
});

// Serverless-Optimized MongoDB Connection Middleware
let isConnected = false;
const connectDB = async () => {
    if (isConnected) return;
    try {
        const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://kunal:KdVygwFo0Anau8uX@hitesh.cqczgkd.mongodb.net/employeeDB';
        const db = await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        isConnected = db.connections[0].readyState === 1;
        console.log("Cloud MongoDB Connected Successfully");
    } catch (err) {
        console.error("Database connection failure: ", err);
        throw err;
    }
};

// Apply database connection barrier to all API routes
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/')) {
        try {
            await connectDB();
        } catch (err) {
            return res.status(500).json({ error: "Operation server database error routing response. Please check MongoDB Atlas IP Whitelist or credentials." });
        }
    }
    next();
});

// Employee Schema
const employeeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    designation: String,
    mobile: String,
    email: String,
    address: String,
    image: String, // Store image as base64 or URL

    // Legacy support for single matchId
    matchId: String,

    // Expanded Match IDs & Error Counts
    matchId1: String,
    errorCount1: { type: Number, default: 0 },
    matchId2: String,
    errorCount2: { type: Number, default: 0 },
    matchId3: String,
    errorCount3: { type: Number, default: 0 },
    matchId4: String,
    errorCount4: { type: Number, default: 0 },

    date: String,
    errorCount: { type: Number, default: 0 }, // This acts as the DAILY total now
    behaviour: String,
    lateMark: String,
    lateTime: String,
    attendance: String,
    status: { type: String, default: 'Active' },
    totalErrors: { type: Number, default: 0 },
    overallPercentage: { type: Number, default: 0 }
});

const Employee = mongoose.model('Employee', employeeSchema);

// Auto-Sync Function for 100% Database Accuracy
async function syncEmployeeStats(empName) {
    try {
        const allLogs = await Employee.find({ name: empName });
        const validLogs = allLogs.filter(log => log.date);

        let total = 0;
        validLogs.forEach(log => { total += (log.errorCount || 0); });

        let percentage = 0;
        if (validLogs.length > 0) { percentage = Math.max(0, 100 - (total * 2)); }

        await Employee.updateMany(
            { name: empName },
            { $set: { totalErrors: total, overallPercentage: percentage } }
        );
    } catch (err) {
        console.error("Auto-sync background task failed:", err);
    }
}

// API Endpoints REST Routing Configurations
app.get('/api/employees', async (req, res) => {
    try { res.json(await Employee.find()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees', async (req, res) => {
    try {
        const newEmployee = new Employee(req.body);
        await newEmployee.save();
        syncEmployeeStats(req.body.name); // Fire-and-forget background task
        res.status(201).json(newEmployee);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/employees/status', async (req, res) => {
    try {
        const { name, status } = req.body;
        await Employee.updateMany({ name }, { $set: { status } });
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/employees/deleteByName', async (req, res) => {
    try {
        const { name } = req.body;
        await Employee.deleteMany({ name });
        res.json({ success: true, message: `All records for ${name} have been deleted.` });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/employees/:id', async (req, res) => {
    try {
        const updatedEmployee = await Employee.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
        syncEmployeeStats(updatedEmployee.name); // Fire-and-forget background task
        res.json(updatedEmployee);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/employees/search', async (req, res) => {
    try {
        const { name } = req.query;
        const employees = await Employee.find({ name: new RegExp(name, 'i') });
        res.json(employees);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- AI ASSISTANT CHATBOT ROUTE (GROQ ENGINE WITH DEDUPLICATION) ---
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const apiKey = process.env.GROQ_API_KEY;

    try {
        // Exclude massive base64 image strings to prevent Groq API token limit crashes
        const employees = await Employee.find().select('-image');
        const dbContext = JSON.stringify(employees);

        // STRICTURE SYSTEM PROMPT: Forces the AI to only return deduplicated unique names without extra explanation
        const systemPrompt = "You are an intelligent HR Assistant for an Employee Management Portal. When asked for a list of employees or names, you MUST return a clean list of unique, deduplicated names where each name appears exactly once. Do not repeat names or give explanatory notes about duplicates. Answer the user's question accurately based ONLY on the provided database context. Be helpful, professional, and concise.";

        const requestBody = JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Database of employees: ${dbContext}\n\nUser Question: ${userMessage}` }
            ]
        });

        const options = {
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody, 'utf8')
            }
        };

        const reqObj = https.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk.toString('utf8'); });
            response.on('end', () => {
                try {
                    const aiData = JSON.parse(data);
                    if (aiData.choices && aiData.choices.length > 0) {
                        let cleanText = aiData.choices[0].message.content.replace(/\*\*/g, '');
                        res.json({ reply: cleanText });
                    } else if (aiData.error) {
                        res.status(400).json({ error: `Groq API Error: ${aiData.error.message}` });
                    } else {
                        res.status(500).json({ error: "Unknown error from Groq AI engine." });
                    }
                } catch (e) {
                    res.status(500).json({ error: "Failed to parse AI response payload." });
                }
            });
        });

        reqObj.on('error', (error) => {
            console.error("HTTPS Network Error:", error);
            res.status(500).json({ error: "Network error connecting to Groq AI service." });
        });

        reqObj.write(requestBody);
        reqObj.end();

    } catch (err) {
        console.error("AI Route Processing Error:", err);
        res.status(500).json({ error: `Internal Backend Processing Failure: ${err.message}` });
    }
});

// Start Server Deployment Routine listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server executing live operational cycles on port ${PORT}`));

// Export the Express API for Vercel Serverless Functions
module.exports = app;