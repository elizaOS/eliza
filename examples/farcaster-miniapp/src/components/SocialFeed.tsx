import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { formatTimeAgo } from '../lib/utils'
import type { FarcasterCast } from '../types'

export function SocialFeed() {
    const [casts, setCasts] = useState<FarcasterCast[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [postMessage, setPostMessage] = useState('')
    const [posting, setPosting] = useState(false)
    const [postSuccess, setPostSuccess] = useState(false)

    useEffect(() => {
        loadFeed()
    }, [])

    async function loadFeed() {
        try {
            setLoading(true)
            setError(null)

            const result = await api.getFarcasterFeed()
            setCasts(result.casts)
        } catch (err: any) {
            console.error('Error loading feed:', err)
            setError(err.message || 'Failed to load feed')
        } finally {
            setLoading(false)
        }
    }

    async function handlePost() {
        if (!postMessage.trim()) return

        try {
            setPosting(true)
            setError(null)
            setPostSuccess(false)

            await api.postToFarcaster(postMessage)

            setPostSuccess(true)
            setPostMessage('')

            // Reload feed after short delay
            setTimeout(() => {
                loadFeed()
                setPostSuccess(false)
            }, 2000)
        } catch (err: any) {
            console.error('Error posting cast:', err)
            setError(err.message || 'Failed to post')
        } finally {
            setPosting(false)
        }
    }

    return (
        <div className="social-container">
            <div className="social-header">
                <h2>Farcaster Feed</h2>
                <button
                    onClick={loadFeed}
                    className="btn-refresh"
                    disabled={loading}
                >
                    🔄 Refresh
                </button>
            </div>

            <div className="post-composer">
                <textarea
                    className="post-textarea"
                    placeholder="Share your trading insights..."
                    value={postMessage}
                    onChange={(e) => setPostMessage(e.target.value)}
                    disabled={posting}
                    maxLength={320}
                />
                <div className="post-actions">
                    <span className="char-count">
                        {postMessage.length} / 320
                    </span>
                    <button
                        className="btn-post"
                        onClick={handlePost}
                        disabled={!postMessage.trim() || posting}
                    >
                        {posting ? 'Posting...' : 'Post'}
                    </button>
                </div>
                {postSuccess && (
                    <div className="post-success">
                        ✅ Posted successfully!
                    </div>
                )}
            </div>

            {loading && (
                <div className="feed-loading">
                    <div className="spinner"></div>
                    <p>Loading feed...</p>
                </div>
            )}

            {error && (
                <div className="feed-error">
                    <p className="error-message">❌ {error}</p>
                    <button onClick={loadFeed} className="btn-retry">
                        Retry
                    </button>
                </div>
            )}

            {!loading && !error && (
                <div className="feed-list">
                    {casts.map((cast) => (
                        <div key={cast.hash} className="cast-card">
                            <div className="cast-header">
                                <div className="cast-author">
                                    {cast.author.pfpUrl && (
                                        <img
                                            src={cast.author.pfpUrl}
                                            alt={cast.author.displayName}
                                            className="author-avatar"
                                        />
                                    )}
                                    <div className="author-info">
                                        <div className="author-name">
                                            {cast.author.displayName}
                                        </div>
                                        <div className="author-username">
                                            @{cast.author.username}
                                        </div>
                                    </div>
                                </div>
                                <div className="cast-time">
                                    {formatTimeAgo(cast.timestamp)}
                                </div>
                            </div>

                            <div className="cast-content">
                                <p>{cast.text}</p>
                            </div>

                            {cast.reactions && (
                                <div className="cast-reactions">
                                    <span className="reaction-item">
                                        ❤️ {cast.reactions.likes}
                                    </span>
                                    <span className="reaction-item">
                                        🔁 {cast.reactions.recasts}
                                    </span>
                                    <span className="reaction-item">
                                        💬 {cast.reactions.replies}
                                    </span>
                                </div>
                            )}
                        </div>
                    ))}

                    {casts.length === 0 && (
                        <div className="feed-empty">
                            <p>No casts found</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

