import React, { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'
import type { ChatMessage } from '../types'

interface ElizaChatProps {
    userFid?: number
}

export function ElizaChat({ userFid }: ElizaChatProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [inputMessage, setInputMessage] = useState('')
    const [loading, setLoading] = useState(false)
    const [sessionId, setSessionId] = useState<string>()
    const messagesEndRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        // Generate session ID
        setSessionId(`session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

        // Add welcome message
        setMessages([
            {
                id: '0',
                role: 'assistant',
                content: 'Hello! I\'m Eliza, your multi-chain trading assistant. I can help you with portfolio analysis, trading strategies, and market insights across Solana and EVM chains. How can I assist you today?',
                timestamp: Date.now(),
                confidence: 1,
            },
        ])
    }, [])

    useEffect(() => {
        // Scroll to bottom when new messages arrive
        scrollToBottom()
    }, [messages])

    function scrollToBottom() {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    async function handleSend() {
        if (!inputMessage.trim() || loading) return

        const userMessage: ChatMessage = {
            id: Date.now().toString(),
            role: 'user',
            content: inputMessage,
            timestamp: Date.now(),
        }

        setMessages((prev) => [...prev, userMessage])
        setInputMessage('')
        setLoading(true)

        try {
            const result = await api.chatWithEliza({
                message: inputMessage,
                sessionId,
                userId: userFid ? `farcaster:${userFid}` : undefined,
            })

            const assistantMessage: ChatMessage = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: result.message,
                timestamp: Date.now(),
                confidence: result.confidence,
                suggestions: result.suggestions,
            }

            setMessages((prev) => [...prev, assistantMessage])

            // Update session ID
            if (result.sessionId) {
                setSessionId(result.sessionId)
            }
        } catch (error: any) {
            console.error('Error sending message:', error)

            const errorMessage: ChatMessage = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: `Sorry, I encountered an error: ${error.message || 'Please try again.'}`,
                timestamp: Date.now(),
            }

            setMessages((prev) => [...prev, errorMessage])
        } finally {
            setLoading(false)
        }
    }

    function handleKeyPress(e: React.KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    function handleSuggestionClick(suggestion: string) {
        setInputMessage(suggestion)
    }

    return (
        <div className="chat-container">
            <div className="chat-header">
                <div className="chat-title">
                    <span className="chat-icon">🤖</span>
                    <h2>Eliza AI</h2>
                </div>
                <div className="chat-subtitle">Multi-Chain Trading Assistant</div>
            </div>

            <div className="chat-messages">
                {messages.map((message) => (
                    <div
                        key={message.id}
                        className={`message ${message.role === 'user' ? 'message-user' : 'message-assistant'}`}
                    >
                        <div className="message-content">
                            <p>{message.content}</p>

                            {message.confidence !== undefined && message.confidence < 0.8 && (
                                <div className="message-confidence">
                                    <span>Confidence: {(message.confidence * 100).toFixed(0)}%</span>
                                </div>
                            )}

                            {message.suggestions && message.suggestions.length > 0 && (
                                <div className="message-suggestions">
                                    <div className="suggestions-label">Suggested actions:</div>
                                    {message.suggestions.map((suggestion, idx) => (
                                        <button
                                            key={idx}
                                            className="suggestion-chip"
                                            onClick={() => handleSuggestionClick(suggestion)}
                                        >
                                            {suggestion}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ))}

                {loading && (
                    <div className="message message-assistant">
                        <div className="message-content">
                            <div className="typing-indicator">
                                <span></span>
                                <span></span>
                                <span></span>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            <div className="chat-input">
                <textarea
                    className="chat-textarea"
                    placeholder="Ask me anything about trading..."
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    onKeyPress={handleKeyPress}
                    disabled={loading}
                    rows={2}
                />
                <button
                    className="btn-send"
                    onClick={handleSend}
                    disabled={!inputMessage.trim() || loading}
                >
                    {loading ? '⏳' : '➤'}
                </button>
            </div>
        </div>
    )
}

