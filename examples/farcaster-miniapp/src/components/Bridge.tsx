import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { formatTokenAmount, parseTokenAmount, debounce } from '../lib/utils'
import { ChainSelector } from './ChainSelector'
import { SUPPORTED_CHAINS, getTokensForChain } from '../lib/chains'
import type { WalletAddresses, BridgeQuote } from '../types'

interface BridgeProps {
    addresses: WalletAddresses
}

export function Bridge({ addresses }: BridgeProps) {
    const [fromChain, setFromChain] = useState('solana')
    const [toChain, setToChain] = useState('base')
    const [fromToken, setFromToken] = useState('')
    const [toToken, setToToken] = useState('')
    const [amount, setAmount] = useState('')
    const [quote, setQuote] = useState<BridgeQuote | null>(null)
    const [loading, setLoading] = useState(false)
    const [quoting, setQuoting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const fromTokens = getTokensForChain(fromChain)
    const toTokens = getTokensForChain(toChain)

    useEffect(() => {
        // Initialize tokens
        if (fromTokens.length > 0) {
            setFromToken(fromTokens[0].address)
        }
    }, [fromChain])

    useEffect(() => {
        // Initialize tokens
        if (toTokens.length > 0) {
            setToToken(toTokens[0].address)
        }
    }, [toChain])

    useEffect(() => {
        if (amount && fromToken && toToken && fromChain !== toChain) {
            debouncedGetQuote()
        } else {
            setQuote(null)
        }
    }, [amount, fromToken, toToken, fromChain, toChain])

    const debouncedGetQuote = debounce(async () => {
        await getQuote()
    }, 800)

    async function getQuote() {
        if (!amount || !fromToken || !toToken || fromChain === toChain) {
            return
        }

        try {
            setQuoting(true)
            setError(null)

            const fromTokenInfo = fromTokens.find(t => t.address === fromToken)
            if (!fromTokenInfo) return

            const parsedAmount = parseTokenAmount(amount, fromTokenInfo.decimals)
            const fromAddress = fromChain === 'solana' ? addresses.solana : addresses.evm

            const result = await api.getBridgeQuote({
                fromChain,
                toChain,
                fromToken,
                toToken,
                amount: parsedAmount,
                fromAddress,
            })

            setQuote(result.quote)
        } catch (err: any) {
            console.error('Error getting bridge quote:', err)
            setError(err.message || 'Failed to get bridge quote')
        } finally {
            setQuoting(false)
        }
    }

    async function executeBridge() {
        if (!quote) return

        try {
            setLoading(true)
            setError(null)
            setSuccess(null)

            const fromAddress = fromChain === 'solana' ? addresses.solana : addresses.evm

            const result = await api.executeBridge({
                quote,
                fromAddress,
            })

            setSuccess(`Bridge transaction initiated! Tx: ${result.txHash.slice(0, 8)}...`)

            // Reset form
            setAmount('')
            setQuote(null)
        } catch (err: any) {
            console.error('Error executing bridge:', err)
            setError(err.message || 'Failed to execute bridge')
        } finally {
            setLoading(false)
        }
    }

    function swapChains() {
        const tempChain = fromChain
        const tempToken = fromToken
        setFromChain(toChain)
        setFromToken(toToken)
        setToChain(tempChain)
        setToToken(tempToken)
    }

    const fromTokenInfo = fromTokens.find(t => t.address === fromToken)
    const toTokenInfo = toTokens.find(t => t.address === toToken)

    return (
        <div className="bridge-container">
            <div className="bridge-header">
                <h2>Cross-Chain Bridge</h2>
                <p className="bridge-subtitle">Transfer tokens between chains</p>
            </div>

            <div className="bridge-form">
                <div className="bridge-section">
                    <label className="section-label">From</label>
                    <ChainSelector
                        chains={SUPPORTED_CHAINS}
                        selectedChain={fromChain}
                        onSelect={setFromChain}
                    />

                    <div className="input-row">
                        <input
                            type="number"
                            className="amount-input"
                            placeholder="0.0"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            disabled={loading}
                        />
                        <select
                            className="token-select"
                            value={fromToken}
                            onChange={(e) => setFromToken(e.target.value)}
                            disabled={loading}
                        >
                            {fromTokens.map((token) => (
                                <option key={token.address} value={token.address}>
                                    {token.symbol}
                                </option>
                            ))}
                        </select>
                    </div>
                    {fromTokenInfo && (
                        <div className="input-hint">{fromTokenInfo.name}</div>
                    )}
                </div>

                <div className="bridge-arrow">
                    <button
                        className="btn-swap-direction"
                        onClick={swapChains}
                        disabled={loading}
                        title="Swap chains"
                    >
                        ⇅
                    </button>
                </div>

                <div className="bridge-section">
                    <label className="section-label">To</label>
                    <ChainSelector
                        chains={SUPPORTED_CHAINS.filter(c => c.id !== fromChain)}
                        selectedChain={toChain}
                        onSelect={setToChain}
                    />

                    <div className="input-row">
                        <input
                            type="text"
                            className="amount-input"
                            placeholder="0.0"
                            value={
                                quote && toTokenInfo
                                    ? formatTokenAmount(quote.toAmount, toTokenInfo.decimals)
                                    : ''
                            }
                            disabled
                        />
                        <select
                            className="token-select"
                            value={toToken}
                            onChange={(e) => setToToken(e.target.value)}
                            disabled={loading}
                        >
                            {toTokens.map((token) => (
                                <option key={token.address} value={token.address}>
                                    {token.symbol}
                                </option>
                            ))}
                        </select>
                    </div>
                    {toTokenInfo && (
                        <div className="input-hint">{toTokenInfo.name}</div>
                    )}
                </div>

                {quoting && (
                    <div className="bridge-status">
                        <div className="spinner-small"></div>
                        <span>Getting bridge quote...</span>
                    </div>
                )}

                {quote && !quoting && (
                    <div className="bridge-details">
                        <div className="detail-row">
                            <span className="detail-label">You will receive</span>
                            <span className="detail-value">
                                {toTokenInfo && formatTokenAmount(quote.toAmount, toTokenInfo.decimals)}{' '}
                                {toTokenInfo?.symbol}
                            </span>
                        </div>
                        {quote.estimatedTime && (
                            <div className="detail-row">
                                <span className="detail-label">Estimated time</span>
                                <span className="detail-value">{quote.estimatedTime}</span>
                            </div>
                        )}
                        {quote.fees && quote.fees.length > 0 && (
                            <div className="detail-row">
                                <span className="detail-label">Bridge fee</span>
                                <span className="detail-value">
                                    {quote.fees.map((fee, idx) => (
                                        <span key={idx}>
                                            {fee.amount} {fee.token}
                                        </span>
                                    ))}
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {error && (
                    <div className="bridge-error">
                        <p className="error-message">❌ {error}</p>
                    </div>
                )}

                {success && (
                    <div className="bridge-success">
                        <p className="success-message">✅ {success}</p>
                    </div>
                )}

                <button
                    className="btn-bridge"
                    onClick={executeBridge}
                    disabled={!quote || loading || quoting || fromChain === toChain}
                >
                    {loading ? 'Bridging...' : 'Bridge'}
                </button>

                {fromChain === toChain && (
                    <p className="bridge-warning">⚠️ Please select different chains</p>
                )}
            </div>
        </div>
    )
}

