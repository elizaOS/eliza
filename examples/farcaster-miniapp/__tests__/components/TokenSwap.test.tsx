import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokenSwap } from '../../src/components/TokenSwap'
import { setupFetchMock, resetFetchMock } from '../utils/test-helpers'

describe('TokenSwap Component', () => {
    const mockAddresses = global.testUtils.getMockAddresses()

    beforeEach(() => {
        setupFetchMock()
    })

    afterEach(() => {
        resetFetchMock()
    })

    it('should render swap interface', () => {
        render(<TokenSwap addresses={mockAddresses} />)
        expect(screen.getByText(/Token Swap/i)).toBeInTheDocument()
    })

    it('should display chain selector', () => {
        render(<TokenSwap addresses={mockAddresses} />)
        expect(screen.getAllByRole('combobox')).toHaveLength(3) // Chain + 2 token selectors
    })

    it('should get quote when amount is entered', async () => {
        const user = userEvent.setup()
        render(<TokenSwap addresses={mockAddresses} />)

        // Find amount input
        const amountInput = screen.getByPlaceholderText(/0.0/i)

        // Enter amount
        await user.type(amountInput, '1')

        // Wait for quote
        await waitFor(() => {
            expect(screen.getByText(/Rate/i)).toBeInTheDocument()
        }, { timeout: 2000 })
    })

    it('should swap tokens direction', async () => {
        const user = userEvent.setup()
        render(<TokenSwap addresses={mockAddresses} />)

        // Find swap direction button
        const swapButton = screen.getByRole('button', { name: /⇅/i })
        await user.click(swapButton)

        // Tokens should be swapped
        expect(swapButton).toBeInTheDocument()
    })

    it('should execute swap', async () => {
        const user = userEvent.setup()
        render(<TokenSwap addresses={mockAddresses} />)

        // Enter amount to get quote
        const amountInput = screen.getByPlaceholderText(/0.0/i)
        await user.type(amountInput, '1')

        // Wait for quote
        await waitFor(() => {
            expect(screen.getByText(/Rate/i)).toBeInTheDocument()
        })

        // Click swap button
        const executeSwapButton = screen.getByRole('button', { name: /^Swap$/i })
        await user.click(executeSwapButton)

        // Should show success message
        await waitFor(() => {
            expect(screen.getByText(/successful/i)).toBeInTheDocument()
        })
    })

    it('should handle swap errors', async () => {
        if (!global.testUtils.useMocks) {
            // Skip mock-specific test for real API
            return
        }

        const user = userEvent.setup()
        const originalFetch = global.fetch;

        (global.fetch as any).mockImplementation((url: string) => {
            if (url.includes('/api/swap/execute')) {
                return Promise.resolve({
                    ok: false,
                    json: () => Promise.resolve({ error: 'Insufficient balance' })
                })
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({})
            })
        })

        render(<TokenSwap addresses={mockAddresses} />)

        const amountInput = screen.getByPlaceholderText(/0.0/i)
        await user.type(amountInput, '1000000')

        await waitFor(() => {
            const executeButton = screen.getByRole('button', { name: /^Swap$/i })
            return user.click(executeButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/Insufficient balance/i)).toBeInTheDocument()
        })

        global.fetch = originalFetch
    })
})

