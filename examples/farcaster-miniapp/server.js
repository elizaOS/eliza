import express from 'express'
import cors from 'cors'
import { createClient } from '@farcaster/quick-auth'
import axios from 'axios'
import { LiFi, ChainId } from '@lifi/sdk'

const app = express()
const quickAuthClient = createClient()

// Environment configuration
const PORT = process.env.PORT || 3001
const ELIZA_API_URL = process.env.ELIZA_API_URL || 'http://localhost:3000'
const HOSTNAME = process.env.HOSTNAME || 'localhost:3001'

// Initialize LiFi SDK
const lifi = new LiFi({
    integrator: 'spartan-multichain',
    apiKey: process.env.LIFI_API_KEY || undefined,
})

// Middleware
app.use(cors())
app.use(express.json())

// Quick Auth middleware for protected routes
const requireAuth = async (req, res, next) => {
    const authorization = req.headers.authorization

    if (!authorization || !authorization.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing token' })
    }

    try {
        const token = authorization.split(' ')[1]
        const payload = await quickAuthClient.verifyJwt({
            token,
            domain: HOSTNAME,
        })

        req.user = {
            fid: payload.sub,
        }

        next()
    } catch (error) {
        console.error('Auth error:', error)
        return res.status(401).json({ error: 'Invalid token' })
    }
}

// Helper function to call ElizaOS agent
async function callElizaAgent(action, params) {
    try {
        const response = await axios.post(`${ELIZA_API_URL}/api/agent/action`, {
            action,
            params,
        })
        return response.data
    } catch (error) {
        console.error('ElizaOS API error:', error.message)
        throw new Error('Failed to communicate with ElizaOS agent')
    }
}

// Get wallet addresses for a user FID
function getWalletAddresses(fid) {
    const walletData = process.env[`WALLET_${fid}`]

    if (!walletData) {
        // Return demo addresses if not configured
        return {
            solana: 'DemoSolanaAddress1234567890',
            evm: '0x0000000000000000000000000000000000000000'
        }
    }

    const [solana, evm] = walletData.split(',')
    return { solana, evm }
}

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Get supported chains
app.get('/api/chains', async (req, res) => {
    try {
        const chains = [
            {
                id: 'solana',
                name: 'Solana',
                type: 'solana',
                icon: '◎',
                nativeCurrency: { symbol: 'SOL', decimals: 9 }
            },
            {
                id: 'ethereum',
                name: 'Ethereum',
                type: 'evm',
                chainId: 1,
                icon: 'Ξ',
                nativeCurrency: { symbol: 'ETH', decimals: 18 }
            },
            {
                id: 'base',
                name: 'Base',
                type: 'evm',
                chainId: 8453,
                icon: '🔵',
                nativeCurrency: { symbol: 'ETH', decimals: 18 }
            },
            {
                id: 'arbitrum',
                name: 'Arbitrum',
                type: 'evm',
                chainId: 42161,
                icon: '🔷',
                nativeCurrency: { symbol: 'ETH', decimals: 18 }
            },
            {
                id: 'optimism',
                name: 'Optimism',
                type: 'evm',
                chainId: 10,
                icon: '🔴',
                nativeCurrency: { symbol: 'ETH', decimals: 18 }
            }
        ]

        res.json({ chains })
    } catch (error) {
        console.error('Error fetching chains:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get user wallet addresses
app.get('/api/user/:fid/wallets', requireAuth, async (req, res) => {
    try {
        const { fid } = req.params
        const addresses = getWalletAddresses(fid)

        res.json({ addresses })
    } catch (error) {
        console.error('Error fetching user wallets:', error)
        res.status(500).json({ error: 'Failed to fetch user wallets' })
    }
})

// Get multi-chain portfolio
app.post('/api/portfolio/multi', requireAuth, async (req, res) => {
    try {
        const { addresses } = req.body // { solana: 'addr', evm: 'addr' }

        const portfolios = []

        // Fetch Solana portfolio
        if (addresses.solana) {
            try {
                const solanaResult = await callElizaAgent('GET_SOLANA_PORTFOLIO', {
                    walletAddress: addresses.solana,
                })

                if (solanaResult.success) {
                    portfolios.push({
                        chain: 'solana',
                        ...solanaResult.data
                    })
                }
            } catch (error) {
                console.error('Error fetching Solana portfolio:', error)
            }
        }

        // Fetch EVM portfolios for each chain
        if (addresses.evm) {
            const evmChains = ['ethereum', 'base', 'arbitrum', 'optimism']

            for (const chain of evmChains) {
                try {
                    const evmResult = await callElizaAgent('GET_EVM_PORTFOLIO', {
                        walletAddress: addresses.evm,
                        chain: chain,
                    })

                    if (evmResult.success) {
                        portfolios.push({
                            chain,
                            ...evmResult.data
                        })
                    }
                } catch (error) {
                    console.error(`Error fetching ${chain} portfolio:`, error)
                }
            }
        }

        res.json({ portfolios })
    } catch (error) {
        console.error('Error fetching multi-chain portfolio:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get swap quote (Solana or EVM)
app.post('/api/swap/quote', requireAuth, async (req, res) => {
    try {
        const { chain, fromToken, toToken, amount, walletAddress } = req.body

        if (chain === 'solana') {
            // Use Jupiter for Solana swaps
            const result = await callElizaAgent('GET_JUPITER_QUOTE', {
                inputMint: fromToken,
                outputMint: toToken,
                amount,
            })

            if (!result.success) {
                throw new Error(result.error || 'Failed to get swap quote')
            }

            res.json({ quote: result.data })
        } else {
            // Use LiFi for EVM swaps
            const chainIdMap = {
                ethereum: 1,
                base: 8453,
                arbitrum: 42161,
                optimism: 10
            }

            const quoteRequest = {
                fromChain: chainIdMap[chain],
                toChain: chainIdMap[chain],
                fromToken,
                toToken,
                fromAmount: amount,
                fromAddress: walletAddress,
            }

            const quote = await lifi.getQuote(quoteRequest)
            res.json({ quote })
        }
    } catch (error) {
        console.error('Error getting swap quote:', error)
        res.status(500).json({ error: error.message })
    }
})

// Execute swap
app.post('/api/swap/execute', requireAuth, async (req, res) => {
    try {
        const { chain, quote, walletAddress } = req.body

        if (chain === 'solana') {
            // Execute Jupiter swap
            const result = await callElizaAgent('EXECUTE_JUPITER_SWAP', {
                quote,
                walletAddress,
            })

            if (!result.success) {
                throw new Error(result.error || 'Failed to execute swap')
            }

            res.json({ signature: result.data.signature })
        } else {
            // Execute EVM swap via LiFi
            const result = await callElizaAgent('EXECUTE_EVM_SWAP', {
                quote,
                walletAddress,
                chain,
            })

            if (!result.success) {
                throw new Error(result.error || 'Failed to execute swap')
            }

            res.json({ txHash: result.data.txHash })
        }
    } catch (error) {
        console.error('Error executing swap:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get bridge quote
app.post('/api/bridge/quote', requireAuth, async (req, res) => {
    try {
        const { fromChain, toChain, fromToken, toToken, amount, fromAddress } = req.body

        const chainIdMap = {
            solana: 1151111081099710,
            ethereum: 1,
            base: 8453,
            arbitrum: 42161,
            optimism: 10
        }

        const quoteRequest = {
            fromChain: chainIdMap[fromChain],
            toChain: chainIdMap[toChain],
            fromToken,
            toToken,
            fromAmount: amount,
            fromAddress,
        }

        const quote = await lifi.getQuote(quoteRequest)
        res.json({ quote })
    } catch (error) {
        console.error('Error getting bridge quote:', error)
        res.status(500).json({ error: error.message })
    }
})

// Execute bridge
app.post('/api/bridge/execute', requireAuth, async (req, res) => {
    try {
        const { quote, fromAddress } = req.body

        const result = await callElizaAgent('EXECUTE_BRIDGE', {
            quote,
            fromAddress,
        })

        if (!result.success) {
            throw new Error(result.error || 'Failed to execute bridge')
        }

        res.json({ txHash: result.data.txHash })
    } catch (error) {
        console.error('Error executing bridge:', error)
        res.status(500).json({ error: error.message })
    }
})

// Post to Farcaster
app.post('/api/social/post', requireAuth, async (req, res) => {
    try {
        const { message } = req.body
        const fid = req.user.fid

        const result = await callElizaAgent('POST_TO_FARCASTER', {
            message,
            fid,
        })

        if (!result.success) {
            throw new Error(result.error || 'Failed to post to Farcaster')
        }

        res.json({ castHash: result.data.castHash })
    } catch (error) {
        console.error('Error posting to Farcaster:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get Farcaster feed
app.get('/api/social/feed', requireAuth, async (req, res) => {
    try {
        const fid = req.user.fid

        const result = await callElizaAgent('GET_FARCASTER_FEED', {
            fid,
        })

        if (!result.success) {
            throw new Error(result.error || 'Failed to get Farcaster feed')
        }

        res.json({ casts: result.data.casts })
    } catch (error) {
        console.error('Error getting Farcaster feed:', error)
        res.status(500).json({ error: error.message })
    }
})

// Chat with Eliza AI
app.post('/api/chat/eliza', requireAuth, async (req, res) => {
    try {
        const { message, sessionId, userId } = req.body
        const fid = req.user.fid

        const result = await callElizaAgent('CHAT_WITH_ELIZA', {
            message,
            sessionId,
            userId: userId || `farcaster:${fid}`,
        })

        if (!result.success) {
            throw new Error(result.error || 'Failed to get Eliza response')
        }

        res.json({
            message: result.data.response.message,
            confidence: result.data.response.confidence || 1,
            suggestions: result.data.response.suggestions || [],
            sessionId: result.data.sessionId,
        })
    } catch (error) {
        console.error('Error chatting with Eliza:', error)
        res.status(500).json({ error: error.message })
    }
})

// Start server
app.listen(PORT, () => {
    console.log(`🤖 Eliza Multi-Chain DeFi API running on port ${PORT}`)
    console.log(`📡 ElizaOS API: ${ELIZA_API_URL}`)
    console.log(`🌐 Hostname: ${HOSTNAME}`)
})

