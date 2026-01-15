import { useState } from 'react';

interface TradingPanelProps {
  isTrading: boolean;
  currentStrategy: string | null;
  onStart: (config: {
    strategy: string;
    maxPositionSize: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    intervalMs: number;
  }) => void;
  onStop: () => void;
  loading: boolean;
  disabled: boolean;
}

const STRATEGIES = [
  { id: 'llm', name: 'LLM Strategy', description: 'AI-powered analysis of trending tokens' },
  { id: 'momentum', name: 'Momentum', description: 'Technical breakout detection' },
  { id: 'mean-reversion', name: 'Mean Reversion', description: 'Trade price deviations' },
  { id: 'rules', name: 'Rule-Based', description: 'Configurable indicator rules' },
];

export function TradingPanel({
  isTrading,
  currentStrategy,
  onStart,
  onStop,
  loading,
  disabled,
}: TradingPanelProps) {
  const [strategy, setStrategy] = useState('llm');
  const [maxPositionSize, setMaxPositionSize] = useState(10);
  const [stopLossPercent, setStopLossPercent] = useState(5);
  const [takeProfitPercent, setTakeProfitPercent] = useState(15);
  const [intervalMinutes, setIntervalMinutes] = useState(1);

  const handleStart = () => {
    onStart({
      strategy,
      maxPositionSize: maxPositionSize / 100,
      stopLossPercent,
      takeProfitPercent,
      intervalMs: intervalMinutes * 60 * 1000,
    });
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">🤖 Trading Controls</h2>
        <div className={`status-badge ${isTrading ? 'status-active' : 'status-inactive'}`}>
          <span className="status-dot"></span>
          {isTrading ? 'ACTIVE' : 'STOPPED'}
        </div>
      </div>

      {isTrading ? (
        <div>
          <div className="alert alert-info">
            Trading with <strong>{currentStrategy}</strong> strategy
          </div>
          <button 
            className="btn btn-danger btn-full"
            onClick={onStop}
            disabled={loading}
          >
            {loading ? <span className="loading-spinner"></span> : '⏹️'} Stop Trading
          </button>
        </div>
      ) : (
        <div>
          <div className="form-group">
            <label className="form-label">Strategy</label>
            <select 
              className="form-select"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              disabled={disabled}
            >
              {STRATEGIES.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} - {s.description}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Max Position Size</label>
            <div className="slider-container">
              <input
                type="range"
                className="slider"
                min="1"
                max="25"
                value={maxPositionSize}
                onChange={(e) => setMaxPositionSize(Number(e.target.value))}
                disabled={disabled}
              />
              <div className="slider-value">{maxPositionSize}% of portfolio</div>
            </div>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Stop Loss</label>
              <div className="slider-container">
                <input
                  type="range"
                  className="slider"
                  min="1"
                  max="20"
                  value={stopLossPercent}
                  onChange={(e) => setStopLossPercent(Number(e.target.value))}
                  disabled={disabled}
                />
                <div className="slider-value">{stopLossPercent}%</div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Take Profit</label>
              <div className="slider-container">
                <input
                  type="range"
                  className="slider"
                  min="5"
                  max="50"
                  value={takeProfitPercent}
                  onChange={(e) => setTakeProfitPercent(Number(e.target.value))}
                  disabled={disabled}
                />
                <div className="slider-value">{takeProfitPercent}%</div>
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Trading Interval</label>
            <select 
              className="form-select"
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              disabled={disabled}
            >
              <option value="1">Every 1 minute</option>
              <option value="5">Every 5 minutes</option>
              <option value="15">Every 15 minutes</option>
              <option value="30">Every 30 minutes</option>
              <option value="60">Every 1 hour</option>
            </select>
          </div>

          <button 
            className="btn btn-success btn-full"
            onClick={handleStart}
            disabled={loading || disabled}
          >
            {loading ? <span className="loading-spinner"></span> : '▶️'} Start Trading
          </button>
        </div>
      )}
    </div>
  );
}
