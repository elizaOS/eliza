import express from 'express'
import cors from 'cors'

const app = express()

// Environment configuration
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// ==================== In-memory DB ====================
// sessionId -> { createdAt, updatedAt, userId, messages: [{ role, content, timestamp }] }
const sessions = new Map()

function nowMs() {
    return Date.now()
}

function createSessionId() {
    return `session-${nowMs()}-${Math.random().toString(36).slice(2, 10)}`
}

function getOrCreateSession(sessionId, userId) {
    if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)
    }
    const id = sessionId || createSessionId()
    const session = {
        id,
        userId: userId || 'demo-user',
        createdAt: nowMs(),
        updatedAt: nowMs(),
        messages: [],
    }
    sessions.set(id, session)
    return session
}

function buildReply(message, session) {
    const trimmed = String(message || '').trim()
    if (!trimmed) {
        return {
            message: "I didn't catch that — can you rephrase?",
            confidence: 0.6,
            suggestions: [],
        }
    }

    const lower = trimmed.toLowerCase()
    if (lower.includes('help')) {
        return {
            message: 'Try: “Summarize my last message”, “Give me 3 next steps”, or “Ask me clarifying questions.”',
            confidence: 0.9,
            suggestions: ['Summarize my last message', 'Give me 3 next steps', 'Ask me clarifying questions'],
        }
    }

    return {
        message: `You said: "${trimmed}". (Session messages: ${session.messages.length})`,
        confidence: 0.9,
        suggestions: [],
    }
}

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Chat with Eliza (in-memory demo)
app.post('/api/chat/eliza', async (req, res) => {
    try {
        const { message, sessionId, userId } = req.body ?? {}
        const session = getOrCreateSession(sessionId, userId)

        session.messages.push({ role: 'user', content: String(message ?? ''), timestamp: nowMs() })
        session.updatedAt = nowMs()

        const reply = buildReply(message, session)
        session.messages.push({ role: 'assistant', content: reply.message, timestamp: nowMs() })
        session.updatedAt = nowMs()

        res.json({ ...reply, sessionId: session.id })
    } catch (error) {
        console.error('Error chatting with Eliza:', error)
        res.status(500).json({ error: error.message })
    }
})

// Start server
app.listen(PORT, () => {
    console.log(`🤖 Eliza Classic Chat API running on port ${PORT}`)
})

