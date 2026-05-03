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
        const { unmount } = render(<App />)
        expect(screen.getByText(/Initializing/i)).toBeInTheDocument()
        // Avoid async state updates after the assertion (React act warning)
        unmount()
    })

    it('should show main app', async () => {
        render(<App />)

        await waitFor(() => {
            expect(screen.getByText(/Eliza/i)).toBeInTheDocument()
        }, { timeout: 3000 })
    })

    it('should send a chat message', async () => {
        const user = userEvent.setup()
        render(<App />)

        await waitFor(() => {
            expect(screen.getByText(/in-memory sessions/i)).toBeInTheDocument()
        })

        const textarea = screen.getByPlaceholderText(/Type a message/i)
        await user.type(textarea, 'Hello there')
        await user.keyboard('{Enter}')

        await waitFor(() => {
            expect(screen.getByText(/Hello there/i)).toBeInTheDocument()
        })
    })
})

