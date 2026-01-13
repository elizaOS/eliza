export function LoadingScreen() {
    return (
        <div className="loading-screen">
            <div className="loading-content">
                <div className="loading-logo">
                    <span className="logo-icon spinning">🤖</span>
                </div>
                <h2 className="loading-title">Eliza Multi-Chain</h2>
                <p className="loading-subtitle">Initializing...</p>
                <div className="loading-spinner">
                    <div className="spinner"></div>
                </div>
            </div>
        </div>
    )
}

