const API_BASE = '/api'

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers,
        },
    })

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(error.error || `HTTP ${response.status}`)
    }

    return response.json()
}

export const api = {
    async health(): Promise<{ status: string; timestamp: string }> {
        return apiRequest('/health')
    },

    // Chat with Eliza AI
    async chatWithEliza(params: {
        message: string
        sessionId?: string
        userId?: string
    }): Promise<{
        message: string
        confidence: number
        suggestions: string[]
        sessionId: string
    }> {
        return apiRequest('/chat/eliza', {
            method: 'POST',
            body: JSON.stringify(params),
        })
    },
}

