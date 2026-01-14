import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { formatTokenAmount, parseTokenAmount, debounce } from '../lib/utils'
import { ChainSelector } from './ChainSelector'
import { SUPPORTED_CHAINS, getTokensForChain } from '../lib/chains'
import type { WalletAddresses, SwapQuote } from '../types'

interface TokenSwapProps {
    addresses: WalletAddresses
}

export function TokenSwap({ addresses }: TokenSwapProps) {
    const [selectedChain, setSelectedChain] = useState('solana')
    const [fromToken, setFromToken] = useState('')
    const [toToken, setToToken] = useState('')
    const [amount, setAmount] = useState('')
    const [quote, setQuote] = useState<SwapQuote | null>(null)
    const [loading, setLoading] = useState(false)
    const [quoting, setQuoting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const tokens = getTokensForChain(selectedChain)

    useEffect(() => {
        // Reset tokens when chain changes
        if (tokens.length > 0) {
            setFromToken(tokens[0].address)
            setToToken(tokens[1]?.address || tokens[0].address)
        }
        setAmount('')
        setQuote(null)
    }, [selectedChain])

    useEffect(() => {
        if (amount && fromToken && toToken && fromToken !== toToken) {
            debouncedGetQuote()
        } else {
            setQuote(null)
        }
    }, [amount, fromToken, toToken, selectedChain])

    const debouncedGetQuote = debounce(async () => {
        await getQuote()
    }, 500)

    async function getQuote() {
        if (!amount || !fromToken || !toToken || fromToken === toToken) {
            return
        }

        try {
            setQuoting(true)
            setError(null)

            const fromTokenInfo = tokens.find(t => t.address === fromToken)
            if (!fromTokenInfo) return

            const parsedAmount = parseTokenAmount(amount, fromTokenInfo.decimals)
            const walletAddress = selectedChain === 'solana' ? addresses.solana : addresses.evm

            const result = await api.getSwapQuote({
                chain: selectedChain,
                fromToken,
                toToken,
                amount: parsedAmount,
                walletAddress,
            })

            setQuote(result.quote)
        } catch (err: any) {
            console.error('Error getting quote:', err)
            setError(err.message || 'Failed to get quote')
        } finally {
            setQuoting(false)
        }
    }

    async function executeSwap() {
        if (!quote) return

        try {
            setLoading(true)
            setError(null)
            setSuccess(null)

            const walletAddress = selectedChain === 'solana' ? addresses.solana : addresses.evm

            const result = await api.executeSwap({
                chain: selectedChain,
                quote,
                walletAddress,
            })

            const txId = result.signature || result.txHash
            setSuccess(`Swap successful! Transaction: ${txId?.slice(0, 8)}...`)

            // Reset form
            setAmount('')
            setQuote(null)
        } catch (err: any) {
            console.error('Error executing swap:', err)
            setError(err.message || 'Failed to execute swap')
        } finally {
            setLoading(false)
        }
    }

    function swapTokens() {
        const temp = fromToken
        setFromToken(toToken)
        setToToken(temp)
    }

    const fromTokenInfo = tokens.find(t => t.address === fromToken)
    const toTokenInfo = tokens.find(t => t.address === toToken)

    return (
        <div className="swap-container">
            <div className="swap-header">
                <h2>Token Swap</h2>
                <ChainSelector
                    chains={SUPPORTED_CHAINS}
                    selectedChain={selectedChain}
                    onSelect={setSelectedChain}
                />
            </div>

            <div className="swap-form">
                <div className="swap-input-group">
                    <label className="input-label">From</label>
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
                            {tokens.map((token) => (
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

                <div className="swap-arrow">
                    <button
                        className="btn-swap-direction"
                        onClick={swapTokens}
                        disabled={loading}
                    >
                        ⇅
                    </button>
                </div>

                <div className="swap-input-group">
                    <label className="input-label">To</label>
                    <div className="input-row">
                        <input
                            type="text"
                            className="amount-input"
                            placeholder="0.0"
                            value={
                                quote && toTokenInfo
                                    ? formatTokenAmount(quote.outputAmount, toTokenInfo.decimals)
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
                            {tokens.map((token) => (
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
                    <div className="swap-status">
                        <div className="spinner-small"></div>
                        <span>Getting quote...</span>
                    </div>
                )}

                {quote && !quoting && (
                    <div className="swap-details">
                        <div className="detail-row">
                            <span className="detail-label">Rate</span>
                            <span className="detail-value">
                                1 {fromTokenInfo?.symbol} ≈{' '}
                                {quote.outputAmount && fromTokenInfo && toTokenInfo
                                    ? (
                                        parseFloat(formatTokenAmount(quote.outputAmount, toTokenInfo.decimals)) /
                                        parseFloat(amount || '1')
                                    ).toFixed(6)
                                    : '0'}{' '}
                                {toTokenInfo?.symbol}
                            </span>
                        </div>
                        {quote.priceImpact && (
                            <div className="detail-row">
                                <span className="detail-label">Price Impact</span>
                                <span className="detail-value">{quote.priceImpact}%</span>
                            </div>
                        )}
                        {quote.estimatedGas && (
                            <div className="detail-row">
                                <span className="detail-label">Est. Gas</span>
                                <span className="detail-value">{quote.estimatedGas}</span>
                            </div>
                        )}
                    </div>
                )}

                {error && (
                    <div className="swap-error">
                        <p className="error-message">❌ {error}</p>
                    </div>
                )}

                {success && (
                    <div className="swap-success">
                        <p className="success-message">✅ {success}</p>
                    </div>
                )}

                <button
                    className="btn-swap"
                    onClick={executeSwap}
                    disabled={!quote || loading || quoting}
                >
                    {loading ? 'Swapping...' : 'Swap'}
                </button>
            </div>
        </div>
    )
}

