interface Trade {
  id: string;
  timestamp: number;
  action: 'BUY' | 'SELL';
  token: string;
  quantity: number;
  price: number;
  reason?: string;
}

interface TradeHistoryProps {
  trades: Trade[];
  performance: {
    totalPnL: number;
    dailyPnL: number;
    winRate: number;
    totalTrades: number;
  };
}

export function TradeHistory({ trades, performance }: TradeHistoryProps) {
  const truncateAddress = (address: string) => {
    if (address.length > 12) {
      return `${address.slice(0, 4)}...${address.slice(-4)}`;
    }
    return address;
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">📜 Trade History</h2>
      </div>

      <div className="stats-grid">
        <div className="stat-item">
          <div className={`stat-value ${performance.totalPnL >= 0 ? 'positive' : 'negative'}`} style={{ color: performance.totalPnL >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
            {performance.totalPnL >= 0 ? '+' : ''}${performance.totalPnL.toFixed(2)}
          </div>
          <div className="stat-label">Total P&L</div>
        </div>
        <div className="stat-item">
          <div className={`stat-value`} style={{ color: performance.dailyPnL >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
            {performance.dailyPnL >= 0 ? '+' : ''}${performance.dailyPnL.toFixed(2)}
          </div>
          <div className="stat-label">Today's P&L</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{(performance.winRate * 100).toFixed(0)}%</div>
          <div className="stat-label">Win Rate</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{performance.totalTrades}</div>
          <div className="stat-label">Total Trades</div>
        </div>
      </div>

      <div style={{ marginTop: '20px' }}>
        {trades.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📝</div>
            <p>No trades yet</p>
          </div>
        ) : (
          trades.map((trade) => (
            <div key={trade.id} className="trade-item">
              <span className={`trade-action ${trade.action.toLowerCase()}`}>
                {trade.action}
              </span>
              <div className="trade-info">
                <div className="trade-token">{truncateAddress(trade.token)}</div>
                <div className="trade-time">
                  {formatDate(trade.timestamp)} {formatTime(trade.timestamp)}
                </div>
              </div>
              <div className="trade-amount">
                <div>{trade.quantity.toFixed(4)}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  @ ${trade.price.toFixed(6)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
