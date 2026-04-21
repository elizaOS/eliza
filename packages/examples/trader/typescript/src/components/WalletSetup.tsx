import React, { useState } from 'react';

interface WalletSetupProps {
  walletAddress: string | null;
  walletBalance: number;
  onConfigure: (config: {
    privateKey: string;
    rpcUrl: string;
    birdeyeApiKey: string;
    anthropicApiKey: string;
  }) => void;
  isConfigured: boolean;
}

export function WalletSetup({ 
  walletAddress, 
  walletBalance, 
  onConfigure,
  isConfigured 
}: WalletSetupProps) {
  const [privateKey, setPrivateKey] = useState('');
  const [rpcUrl, setRpcUrl] = useState('https://api.mainnet-beta.solana.com');
  const [birdeyeApiKey, setBirdeyeApiKey] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [showForm, setShowForm] = useState(!isConfigured);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfigure({
      privateKey,
      rpcUrl,
      birdeyeApiKey,
      anthropicApiKey,
    });
    setShowForm(false);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">💼 Wallet Setup</h2>
        {isConfigured && (
          <button 
            className="btn btn-secondary"
            onClick={() => setShowForm(!showForm)}
          >
            {showForm ? 'Cancel' : 'Edit'}
          </button>
        )}
      </div>

      {isConfigured && !showForm && walletAddress && (
        <div>
          <div className="form-group">
            <label className="form-label">Connected Wallet</label>
            <div className="wallet-address">{walletAddress}</div>
          </div>
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value">{walletBalance.toFixed(4)}</div>
              <div className="stat-label">SOL Balance</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">${(walletBalance * 150).toFixed(2)}</div>
              <div className="stat-label">USD Value (est)</div>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit}>
          <div className="alert alert-warning">
            ⚠️ Your private key is stored locally and never sent to any server. 
            Use a dedicated trading wallet with limited funds.
          </div>

          <div className="form-group">
            <label className="form-label">Solana Private Key (Base58)</label>
            <input
              type="password"
              className="form-input"
              placeholder="Enter your private key..."
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">RPC URL</label>
            <input
              type="url"
              className="form-input"
              placeholder="https://api.mainnet-beta.solana.com"
              value={rpcUrl}
              onChange={(e) => setRpcUrl(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Birdeye API Key</label>
            <input
              type="password"
              className="form-input"
              placeholder="Enter Birdeye API key..."
              value={birdeyeApiKey}
              onChange={(e) => setBirdeyeApiKey(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Anthropic API Key (for LLM strategy)</label>
            <input
              type="password"
              className="form-input"
              placeholder="Enter Anthropic API key..."
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary btn-full">
            Connect Wallet
          </button>
        </form>
      )}
    </div>
  );
}
