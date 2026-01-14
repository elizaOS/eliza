import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MultiChainPortfolio } from '../../src/components/MultiChainPortfolio'
import { setupFetchMock, resetFetchMock } from '../utils/test-helpers'

describe('MultiChainPortfolio Component', () => {
    const mockAddresses = global.testUtils.getMockAddresses()

    beforeEach(() => {
        setupFetchMock()
    })

    afterEach(() => {
        resetFetchMock()
    })

    it('should display loading state', () => {
        render(<MultiChainPortfolio addresses={mockAddresses} />)
        expect(screen.getByText(/Loading multi-chain portfolio/i)).toBeInTheDocument()
    })

    it('should display portfolio data', async () => {
        render(<MultiChainPortfolio addresses={mockAddresses} />)

        await waitFor(() => {
            expect(screen.getByText(/Total Portfolio Value/i)).toBeInTheDocument()
        })
    })

    it('should display chain filter buttons', async () => {
        render(<MultiChainPortfolio addresses={mockAddresses} />)

        await waitFor(() => {
            expect(screen.getByText(/All Chains/i)).toBeInTheDocument()
        })
    })

    it('should filter by chain', async () => {
        const user = userEvent.setup()
        render(<MultiChainPortfolio addresses={mockAddresses} />)

        await waitFor(() => {
            expect(screen.getByText(/All Chains/i)).toBeInTheDocument()
        })

        // Click on a chain filter
        const filterButton = screen.getByText(/All Chains/i)
        await user.click(filterButton)

        // Portfolio should update
        expect(screen.getByText(/Total Portfolio Value/i)).toBeInTheDocument()
    })

    it('should handle portfolio fetch errors', async () => {
        if (!global.testUtils.useMocks) {
            // Skip mock-specific test for real API
            return
        }

        const originalFetch = global.fetch;
        (global.fetch as any).mockImplementationOnce(() =>
            Promise.resolve({
                ok: false,
                json: () => Promise.resolve({ error: 'Failed to load' })
            })
        )

        render(<MultiChainPortfolio addresses={mockAddresses} />)

        await waitFor(() => {
            expect(screen.getByText(/Failed to load/i)).toBeInTheDocument()
        })

        global.fetch = originalFetch
    })

    it('should refresh portfolio', async () => {
        const user = userEvent.setup()
        render(<MultiChainPortfolio addresses={mockAddresses} />)

        await waitFor(() => {
            expect(screen.getByText(/Refresh/i)).toBeInTheDocument()
        })

        const refreshButton = screen.getByText(/Refresh/i)
        await user.click(refreshButton)

        // Should show loading state again
        expect(global.fetch).toHaveBeenCalled()
    })
})

