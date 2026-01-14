import { useState, useEffect } from 'react'
import { sdk } from '@farcaster/miniapp-sdk'
import { Header } from './components/Header'
import { LoadingScreen } from './components/LoadingScreen'
import { MultiChainPortfolio } from './components/MultiChainPortfolio'
import { TokenSwap } from './components/TokenSwap'
import { Bridge } from './components/Bridge'
import { SocialFeed } from './components/SocialFeed'
import { ElizaChat } from './components/ElizaChat'
import { api } from './lib/api'
import type { User, WalletAddresses } from './types'
import './App.css'

type Tab = 'portfolio' | 'swap' | 'bridge' | 'social' | 'chat'

function App() {
    const [isLoading, setIsLoading] = useState(true)
    const [isAuthenticated, setIsAuthenticated] = useState(false)
    const [user, setUser] = useState<User | null>(null)
    const [addresses, setAddresses] = useState<WalletAddresses | null>(null)
    const [activeTab, setActiveTab] = useState<Tab>('portfolio')
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        initialize()
    }, [])

    async function initialize() {
        try {
            setError(null)

            // Get Quick Auth token to authenticate the user
            const { token } = await sdk.quickAuth.getToken()

            if (token) {
                // Decode token to get user FID
                const payload = JSON.parse(atob(token.split('.')[1]))
                const fid = parseInt(payload.sub)

                setUser({ fid })
                setIsAuthenticated(true)

                // Fetch user's wallet addresses from backend
                try {
                    const result = await api.getUserWallets(fid)
                    setAddresses(result.addresses)
                } catch (err) {
                    console.error('Error fetching wallets:', err)
                    // Set demo addresses as fallback
                    setAddresses({
                        solana: 'DemoSolanaAddress1234567890',
                        evm: '0x0000000000000000000000000000000000000000'
                    })
                }
            }

            // Tell Farcaster the app is ready to display
            await sdk.actions.ready()
        } catch (error: any) {
            console.error('Failed to initialize:', error)
            setError(error.message || 'Failed to initialize app')
        } finally {
            setIsLoading(false)
        }
    }

    if (isLoading) {
        return <LoadingScreen />
    }

    if (error) {
        return (
            <div className="error-container">
                <div className="error-card">
                    <h1>🤖 Eliza Multi-Chain</h1>
                    <p className="error-message">⚠️ {error}</p>
                    <button onClick={initialize} className="btn-retry">
                        Retry
                    </button>
                </div>
            </div>
        )
    }

    if (!isAuthenticated || !addresses) {
        return (
            <div className="auth-container">
                <div className="auth-card">
                    <h1>🤖 Eliza Multi-Chain</h1>
                    <p>ElizaOS Multi-Chain Trading Platform</p>
                    <p className="error">Authentication failed. Please try again.</p>
                    <button onClick={initialize} className="btn-retry">
                        Retry
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="app">
            <Header user={user} addresses={addresses} />

            <nav className="tab-nav">
                <button
                    className={`tab ${activeTab === 'portfolio' ? 'active' : ''}`}
                    onClick={() => setActiveTab('portfolio')}
                >
                    <span className="tab-icon">💼</span>
                    <span className="tab-label">Portfolio</span>
                </button>
                <button
                    className={`tab ${activeTab === 'swap' ? 'active' : ''}`}
                    onClick={() => setActiveTab('swap')}
                >
                    <span className="tab-icon">🔄</span>
                    <span className="tab-label">Swap</span>
                </button>
                <button
                    className={`tab ${activeTab === 'bridge' ? 'active' : ''}`}
                    onClick={() => setActiveTab('bridge')}
                >
                    <span className="tab-icon">🌉</span>
                    <span className="tab-label">Bridge</span>
                </button>
                <button
                    className={`tab ${activeTab === 'social' ? 'active' : ''}`}
                    onClick={() => setActiveTab('social')}
                >
                    <span className="tab-icon">📱</span>
                    <span className="tab-label">Social</span>
                </button>
                <button
                    className={`tab ${activeTab === 'chat' ? 'active' : ''}`}
                    onClick={() => setActiveTab('chat')}
                >
                    <span className="tab-icon">🤖</span>
                    <span className="tab-label">AI Chat</span>
                </button>
            </nav>

            <main className="content">
                {activeTab === 'portfolio' && <MultiChainPortfolio addresses={addresses} />}
                {activeTab === 'swap' && <TokenSwap addresses={addresses} />}
                {activeTab === 'bridge' && <Bridge addresses={addresses} />}
                {activeTab === 'social' && <SocialFeed />}
                {activeTab === 'chat' && <ElizaChat userFid={user?.fid} />}
            </main>
        </div>
    )
}

export default App

