import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import './index.css';
import React from 'react';
import type { UUID } from '@elizaos/core';

const queryClient = new QueryClient();

// Define the interface for the ELIZA_CONFIG
interface ElizaConfig {
  agentId: string;
  apiBase: string;
}

// Declare global window extension for TypeScript
declare global {
  interface Window {
    ELIZA_CONFIG?: ElizaConfig;
  }
}

/**
 * Main TEE Status route component
 */
function TEEStatusRoute() {
  const config = window.ELIZA_CONFIG;
  const agentId = config?.agentId;

  // Apply dark mode to the root element
  React.useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  if (!agentId) {
    return (
      <div className="p-4 text-center">
        <div className="text-red-600 font-medium">Error: Agent ID not found</div>
        <div className="text-sm text-gray-600 mt-2">
          The server should inject the agent ID configuration.
        </div>
      </div>
    );
  }

  return <TEEProvider agentId={agentId as UUID} />;
}

/**
 * TEE Status provider component
 */
function TEEProvider({ agentId }: { agentId: UUID }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <TEEStatusPanel agentId={agentId} />
      </div>
    </QueryClientProvider>
  );
}

// Initialize the application - no router needed for iframe
const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<TEEStatusRoute />);
}

// Define types for integration with agent UI system
export interface AgentPanel {
  name: string;
  path: string;
  component: React.ComponentType<any>;
  icon?: string;
  public?: boolean;
  shortLabel?: string; // Optional short label for mobile
}

interface PanelProps {
  agentId: string;
}

// Error types for better error handling
type TEEError = {
  type: 'network' | 'timeout' | 'server' | 'parse' | 'unknown';
  message: string;
  details?: string;
  retryable: boolean;
};

type TEEStatus = {
  connected: boolean;
  loading: boolean;
  mode?: string;
  vendor?: string;
  error?: TEEError;
  lastUpdated?: string;
};

// Create a network error helper
const createNetworkError = (error: Error): TEEError => {
  // Network failure detection
  if (error.name === 'NetworkError' || error.message.includes('Failed to fetch')) {
    return {
      type: 'network',
      message: 'Network connection failed',
      details: 'Unable to reach the TEE service. Please check your connection.',
      retryable: true,
    };
  }

  // Timeout detection
  if (error.name === 'AbortError' || error.message.includes('timeout')) {
    return {
      type: 'timeout',
      message: 'Request timeout',
      details: 'The TEE service is taking too long to respond.',
      retryable: true,
    };
  }

  // Server error detection
  if (error.message.includes('5')) {
    return {
      type: 'server',
      message: 'Server error',
      details: 'The TEE service encountered an internal error.',
      retryable: true,
    };
  }

  return {
    type: 'unknown',
    message: error.message || 'An unknown error occurred',
    details: 'Please try again or contact support if the problem persists.',
    retryable: true,
  };
};

// Fetch with timeout and retry logic
const fetchWithRetry = async (
  url: string,
  options: { timeout?: number; retries?: number } = {}
): Promise<Response> => {
  const { timeout = 10000, retries = 3 } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }

      // Wait before retry (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
    }
  }

  throw new Error('Max retries exceeded');
};

/**
 * TEE Status panel component that shows TEE connection status and information
 */
const TEEStatusPanel: React.FC<PanelProps> = ({ agentId }) => {
  const [teeStatus, setTeeStatus] = React.useState<TEEStatus>({
    connected: false,
    loading: true,
  });

  // Function to fetch TEE status with improved error handling
  const fetchTEEStatus = React.useCallback(async () => {
    try {
      setTeeStatus((prev) => ({ ...prev, loading: true, error: undefined }));

      const response = await fetchWithRetry('/mr-tee-status', {
        timeout: 10000,
        retries: 3,
      });

      const data = await response.json();

      setTeeStatus({
        connected: true,
        loading: false,
        mode: data.tee_mode,
        vendor: data.tee_vendor,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      const teeError = createNetworkError(error as Error);
      setTeeStatus({
        connected: false,
        loading: false,
        error: teeError,
        lastUpdated: new Date().toISOString(),
      });
    }
  }, []);

  // Auto-retry function
  const retryConnection = React.useCallback(() => {
    fetchTEEStatus();
  }, [fetchTEEStatus]);

  React.useEffect(() => {
    fetchTEEStatus();

    // Set up periodic refresh every 30 seconds
    const interval = setInterval(fetchTEEStatus, 30000);

    return () => clearInterval(interval);
  }, [fetchTEEStatus]);

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground mb-2">Mr. TEE Status</h1>
          <p className="text-muted-foreground">
            Agent ID: <code className="text-sm bg-muted px-2 py-1 rounded">{agentId}</code>
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Connection Status Card */}
          <div className="bg-card rounded-lg p-6 border border-border">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">TEE Connection</h2>
              {teeStatus.loading && (
                <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full"></div>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <span
                  className={`tee-status-badge ${
                    teeStatus.loading
                      ? 'loading'
                      : teeStatus.connected
                        ? 'connected'
                        : 'disconnected'
                  }`}
                >
                  {teeStatus.loading
                    ? 'Connecting...'
                    : teeStatus.connected
                      ? 'Connected'
                      : 'Disconnected'}
                </span>
              </div>
              {teeStatus.mode && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Mode</span>
                  <span className="text-foreground">{teeStatus.mode}</span>
                </div>
              )}
              {teeStatus.vendor && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Vendor</span>
                  <span className="text-foreground">{teeStatus.vendor}</span>
                </div>
              )}
              {teeStatus.lastUpdated && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last Updated</span>
                  <span className="text-foreground text-sm">
                    {new Date(teeStatus.lastUpdated).toLocaleTimeString()}
                  </span>
                </div>
              )}
              {teeStatus.error && (
                <div className="mt-4 space-y-3">
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-destructive">
                        {teeStatus.error.message}
                      </p>
                      <span className="text-xs px-2 py-1 bg-destructive/20 text-destructive rounded">
                        {teeStatus.error.type}
                      </span>
                    </div>
                    {teeStatus.error.details && (
                      <p className="text-xs text-destructive/80">{teeStatus.error.details}</p>
                    )}
                  </div>
                  {teeStatus.error.retryable && (
                    <button
                      onClick={retryConnection}
                      disabled={teeStatus.loading}
                      className="w-full px-3 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {teeStatus.loading ? 'Retrying...' : 'Retry Connection'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* TEE Information Card */}
          <div className="bg-card rounded-lg p-6 border border-border">
            <h2 className="text-xl font-semibold mb-4">TEE Information</h2>
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-1">About TEE</h3>
                <p className="text-sm">
                  Trusted Execution Environment provides hardware-based security for sensitive
                  operations, including key derivation and cryptographic signing.
                </p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-1">Features</h3>
                <ul className="text-sm space-y-1">
                  <li>• Secure key derivation</li>
                  <li>• Hardware-isolated execution</li>
                  <li>• Remote attestation support</li>
                  <li>• Protected memory regions</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Agent Portrait */}
          <div className="md:col-span-2 bg-card rounded-lg p-6 border border-border">
            <h2 className="text-xl font-semibold mb-4">Agent Portrait</h2>
            <div className="flex justify-center">
              <img
                src="/assets/mr-tee-portrait.jpg"
                alt="Mr. TEE"
                className="w-48 h-48 rounded-full border-4 border-primary"
              />
            </div>
            <p className="text-center mt-4 text-muted-foreground">
              Mr. TEE - Your Trusted Execution Environment Agent
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

// Export the panel configuration for integration with the agent UI
export const panels: AgentPanel[] = [
  {
    name: 'TEE Status',
    path: 'tee-status',
    component: TEEStatusPanel,
    icon: 'Shield',
    public: false,
    shortLabel: 'TEE',
  },
];

export * from './utils';
