import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../src/App'
import { setupFetchMock, resetFetchMock } from '../utils/test-helpers'

describe('App Component', () => {
    beforeEach(() => {
        setupFetchMock()
    })

    afterEach(() => {
        resetFetchMock()
    })

    it('should render loading screen initially', () => {
        render(<App />)
        expect(screen.getByText(/Initializing/i)).toBeInTheDocument()
    })

    it('should authenticate and show main app', async () => {
        render(<App />)

        await waitFor(() => {
            expect(screen.getByText(/Eliza/i)).toBeInTheDocument()
        }, { timeout: 3000 })
    })

    it('should display navigation tabs', async () => {
        render(<App />)

        await waitFor(() => {
            expect(screen.getByText(/Portfolio/i)).toBeInTheDocument()
            expect(screen.getByText(/Swap/i)).toBeInTheDocument()
            expect(screen.getByText(/Bridge/i)).toBeInTheDocument()
            expect(screen.getByText(/Social/i)).toBeInTheDocument()
            expect(screen.getByText(/AI Chat/i)).toBeInTheDocument()
        })
    })

    it('should switch between tabs', async () => {
        const user = userEvent.setup()
        render(<App />)

        await waitFor(() => {
            expect(screen.getByText(/Portfolio/i)).toBeInTheDocument()
        })

        // Click Swap tab
        const swapTab = screen.getByText(/Swap/i)
        await user.click(swapTab)

        // Should show swap component
        await waitFor(() => {
            expect(screen.getByText(/Token Swap/i)).toBeInTheDocument()
        })
    })

    it('should handle authentication errors', async () => {
        if (!global.testUtils.useMocks) {
            // Skip mock-specific test for real API
            return
        }

        // Mock auth failure
        const originalFetch = global.fetch;
        (global.fetch as any).mockImplementationOnce(() =>
            Promise.reject(new Error('Auth failed'))
        )

        render(<App />)

        await waitFor(() => {
            expect(screen.getByText(/failed to initialize/i)).toBeInTheDocument()
        }, { timeout: 5000 })

        global.fetch = originalFetch
    })
})

