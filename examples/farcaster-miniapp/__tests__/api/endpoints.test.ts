import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupFetchMock, resetFetchMock } from '../utils/test-helpers'

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001'

describe('API Endpoints (demo)', () => {
    beforeEach(() => {
        setupFetchMock()
    })

    afterEach(() => {
        resetFetchMock()
    })

    it('health should return ok', async () => {
        const response = await fetch(`${API_BASE}/health`)
        expect(response.ok).toBe(true)
        const data = await response.json()
        expect(data.status).toBe('ok')
        expect(typeof data.timestamp).toBe('string')
    })

    it('chat should return message + sessionId', async () => {
        const response = await fetch(`${API_BASE}/api/chat/eliza`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Hello', userId: 'demo-user' }),
        })
        expect(response.ok).toBe(true)
        const data = await response.json()
        expect(typeof data.message).toBe('string')
        expect(typeof data.sessionId).toBe('string')
        expect(Array.isArray(data.suggestions)).toBe(true)
    })
})

