import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { formatCurrency, formatTokenAmount } from '../lib/utils'
import { ChainBadge } from './ChainBadge'
import type { Portfolio, WalletAddresses } from '../types'

interface MultiChainPortfolioProps {
    addresses: WalletAddresses
}

export function MultiChainPortfolio({ addresses }: MultiChainPortfolioProps) {
    const [portfolios, setPortfolios] = useState<Portfolio[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [selectedChain, setSelectedChain] = useState<string | null>(null)
    const [totalValue, setTotalValue] = useState(0)

    useEffect(() => {
        loadPortfolios()
    }, [addresses])

    useEffect(() => {
        // Calculate total value across all chains
        const total = portfolios.reduce((sum, portfolio) => {
            const value = parseFloat(portfolio.totalValueUSD || '0')
            return sum + value
        }, 0)
        setTotalValue(total)
    }, [portfolios])

    async function loadPortfolios() {
        try {
            setLoading(true)
            setError(null)

            const result = await api.getMultiChainPortfolio(addresses)
            setPortfolios(result.portfolios)
        } catch (err: any) {
            console.error('Error loading portfolios:', err)
            setError(err.message || 'Failed to load portfolios')
        } finally {
            setLoading(false)
        }
    }

    if (loading) {
        return (
            <div className="portfolio-container">
                <div className="portfolio-loading">
                    <div className="spinner"></div>
                    <p>Loading multi-chain portfolio...</p>
                </div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="portfolio-container">
                <div className="portfolio-error">
                    <p className="error-message">❌ {error}</p>
                    <button onClick={loadPortfolios} className="btn-retry">
                        Retry
                    </button>
                </div>
            </div>
        )
    }

    const displayedPortfolios = selectedChain
        ? portfolios.filter(p => p.chain === selectedChain)
        : portfolios

    return (
        <div className="portfolio-container">
            <div className="portfolio-header">
                <div className="portfolio-total">
                    <div className="total-label">Total Portfolio Value</div>
                    <div className="total-value">{formatCurrency(totalValue)}</div>
                </div>

                <div className="portfolio-actions">
                    <button
                        onClick={loadPortfolios}
                        className="btn-refresh"
                        disabled={loading}
                    >
                        🔄 Refresh
                    </button>
                </div>
            </div>

            <div className="chain-filter">
                <button
                    className={`filter-btn ${!selectedChain ? 'active' : ''}`}
                    onClick={() => setSelectedChain(null)}
                >
                    All Chains
                </button>
                {portfolios.map((portfolio) => (
                    <button
                        key={portfolio.chain}
                        className={`filter-btn ${selectedChain === portfolio.chain ? 'active' : ''}`}
                        onClick={() => setSelectedChain(portfolio.chain)}
                    >
                        <ChainBadge chainId={portfolio.chain} size="small" />
                    </button>
                ))}
            </div>

            <div className="portfolio-grid">
                {displayedPortfolios.map((portfolio) => (
                    <div key={portfolio.chain} className="portfolio-card">
                        <div className="card-header">
                            <ChainBadge chainId={portfolio.chain} />
                            <div className="card-value">
                                {formatCurrency(parseFloat(portfolio.totalValueUSD || '0'))}
                            </div>
                        </div>

                        <div className="card-native-balance">
                            <div className="balance-label">Native Balance</div>
                            <div className="balance-amount">
                                {formatTokenAmount(portfolio.nativeBalance, 18)}
                                {portfolio.nativeBalanceUSD && (
                                    <span className="balance-usd">
                                        {formatCurrency(parseFloat(portfolio.nativeBalanceUSD))}
                                    </span>
                                )}
                            </div>
                        </div>

                        {portfolio.tokens && portfolio.tokens.length > 0 && (
                            <div className="card-tokens">
                                <div className="tokens-header">Tokens</div>
                                <div className="tokens-list">
                                    {portfolio.tokens.map((token, idx) => (
                                        <div key={idx} className="token-item">
                                            <div className="token-info">
                                                <div className="token-symbol">{token.symbol}</div>
                                                <div className="token-name">{token.name}</div>
                                            </div>
                                            <div className="token-balance">
                                                <div className="token-amount">
                                                    {formatTokenAmount(token.balance || '0', token.decimals)}
                                                </div>
                                                {token.balanceUSD && (
                                                    <div className="token-usd">
                                                        {formatCurrency(parseFloat(token.balanceUSD))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {(!portfolio.tokens || portfolio.tokens.length === 0) && (
                            <div className="card-empty">
                                <p>No tokens found</p>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {displayedPortfolios.length === 0 && (
                <div className="portfolio-empty">
                    <p>No portfolios found</p>
                </div>
            )}
        </div>
    )
}

