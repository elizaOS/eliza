import { useState, useCallback } from 'react';
import type { AgentRuntime } from '@elizaos/core';
import { getRuntime, resetRuntime, isRuntimeInitialized } from './runtime';
import { useTrading } from './hooks/useTrading';
import { WalletSetup } from './components/WalletSetup';
import { TradingPanel } from './components/TradingPanel';
import { PositionList } from './components/PositionList';
import { TradeHistory } from './components/TradeHistory';

function App() {
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null);
  const [isConfigured, setIsConfigured] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [initLoading, setInitLoading] = useState(false);

  const { state, loading, error, startTrading, stopTrading } = useTrading(runtime);

  const handleConfigure = useCallback(async (config: {
    privateKey: string;
    rpcUrl: string;
    birdeyeApiKey: string;
    anthropicApiKey: string;
  }) => {
    setInitLoading(true);
    setInitError(null);

    // Reset existing runtime if any
    if (isRuntimeInitialized()) {
      resetRuntime();
    }

    const newRuntime = await getRuntime({
      solanaPrivateKey: config.privateKey,
      solanaRpcUrl: config.rpcUrl,
      birdeyeApiKey: config.birdeyeApiKey,
      anthropicApiKey: config.anthropicApiKey,
      tradingMode: 'paper', // Default to paper trading for safety
    });

    setRuntime(newRuntime);
    setIsConfigured(true);
    setInitLoading(false);
  }, []);

  const handleStartTrading = useCallback(async (config: {
    strategy: string;
    maxPositionSize: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    intervalMs: number;
  }) => {
    await startTrading({
      strategy: config.strategy,
      maxPositionSize: config.maxPositionSize,
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      intervalMs: config.intervalMs,
    });
  }, [startTrading]);

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>⚡ ElizaOS Auto Trader</h1>
        <p>AI-powered autonomous trading on Solana</p>
      </header>

      {initError && (
        <div className="alert alert-warning" style={{ marginBottom: '24px' }}>
          {initError}
        </div>
      )}

      {error && (
        <div className="alert alert-warning" style={{ marginBottom: '24px' }}>
          {error}
        </div>
      )}

      <div className="grid-2">
        <div>
          <WalletSetup
            walletAddress={state.walletAddress}
            walletBalance={state.walletBalance}
            onConfigure={handleConfigure}
            isConfigured={isConfigured}
          />

          <div style={{ marginTop: '24px' }}>
            <TradingPanel
              isTrading={state.isTrading}
              currentStrategy={state.strategy}
              onStart={handleStartTrading}
              onStop={stopTrading}
              loading={loading || initLoading}
              disabled={!isConfigured}
            />
          </div>
        </div>

        <div>
          <PositionList 
            positions={state.positions}
          />

          <div style={{ marginTop: '24px' }}>
            <TradeHistory 
              trades={state.recentTrades}
              performance={state.performance}
            />
          </div>
        </div>
      </div>

      <footer style={{ 
        textAlign: 'center', 
        marginTop: '48px', 
        padding: '24px',
        color: 'var(--text-muted)',
        fontSize: '0.875rem'
      }}>
        <p>
          ⚠️ Trading cryptocurrencies involves significant risk. 
          Only trade with funds you can afford to lose.
        </p>
        <p style={{ marginTop: '8px' }}>
          Built with ElizaOS • <a href="https://github.com/elizaos/eliza" style={{ color: 'var(--accent-primary)' }}>GitHub</a>
        </p>
      </footer>
    </div>
  );
}

export default App;
