import { render, RenderOptions } from '@testing-library/react'
import { ReactElement } from 'react'
import { vi } from 'vitest'
import type { WalletAddresses } from '../../src/types'

// Mock API responses
export const mockApiResponses = {
    elizaChat: {
        message: 'Hello! How can I help you today?',
        confidence: 0.95,
        suggestions: [],
        sessionId: 'test-session-123'
    }
}

function toUrlString(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.toString()
    if (input instanceof Request) return input.url
    return String(input)
}

// Setup fetch mock (only if using mocks)
export function setupFetchMock() {
    if (!global.testUtils.useMocks) {
        // Use real fetch when not mocking
        return
    }

    const fetchMock = global.testUtils.fetchMock
    if (!fetchMock) {
        throw new Error('fetchMock not initialized. Did setupFiles run?')
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const urlStr = toUrlString(input)

        // Health check
        if (urlStr.endsWith('/health') || urlStr.includes('/health')) {
            return new Response(
                JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        }

        // Eliza chat
        if (urlStr.includes('/api/chat/eliza')) {
            return new Response(JSON.stringify(mockApiResponses.elizaChat), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        // Default 404
        return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        })
    })
}

// Reset fetch mock
export function resetFetchMock() {
    global.testUtils.fetchMock?.mockClear()
}

// Custom render with providers
export function renderWithProviders(
    ui: ReactElement,
    options?: Omit<RenderOptions, 'wrapper'>
) {
    return render(ui, { ...options })
}

// Wait for element to appear
export async function waitForElement<T>(callback: () => T | null | undefined, timeout = 3000): Promise<T> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
        try {
            const result = callback()
            if (result) return result
        } catch (e) {
            // Continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    throw new Error('Timeout waiting for element')
}

