interface Position {
  id: string;
  tokenAddress: string;
  symbol?: string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

interface PositionListProps {
  positions: Position[];
  onClosePosition?: (positionId: string) => void;
}

export function PositionList({ positions, onClosePosition }: PositionListProps) {
  const truncateAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">📊 Open Positions</h2>
        <span className="card-subtitle">{positions.length} position{positions.length !== 1 ? 's' : ''}</span>
      </div>

      {positions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <p>No open positions</p>
        </div>
      ) : (
        <div>
          {positions.map((position) => (
            <div key={position.id} className="position-item">
              <div className="position-header">
                <div>
                  <span className="position-symbol">
                    {position.symbol || truncateAddress(position.tokenAddress)}
                  </span>
                </div>
                <span className={`position-pnl ${position.pnl >= 0 ? 'positive' : 'negative'}`}>
                  {position.pnl >= 0 ? '+' : ''}{position.pnlPercent.toFixed(2)}%
                </span>
              </div>
              <div className="position-details">
                <div>
                  <div className="position-detail-label">Entry</div>
                  <div className="position-detail-value">${position.entryPrice.toFixed(6)}</div>
                </div>
                <div>
                  <div className="position-detail-label">Current</div>
                  <div className="position-detail-value">${position.currentPrice.toFixed(6)}</div>
                </div>
                <div>
                  <div className="position-detail-label">P&L</div>
                  <div className={`position-detail-value ${position.pnl >= 0 ? 'positive' : 'negative'}`}>
                    ${position.pnl.toFixed(2)}
                  </div>
                </div>
              </div>
              {onClosePosition && (
                <button 
                  className="btn btn-secondary btn-full"
                  style={{ marginTop: '12px' }}
                  onClick={() => onClosePosition(position.id)}
                >
                  Close Position
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
