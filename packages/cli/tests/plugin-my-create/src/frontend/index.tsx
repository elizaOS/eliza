import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
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

// Define the interface for time response
interface TimeResponse {
  timestamp: string;
  unix: number;
  formatted: string;
  timezone: string;
}

/**
 * Time display component that fetches from backend
 */
function TimeDisplay({ apiBase }: { apiBase: string }) {
  const { data, isLoading, error, refetch } = useQuery<TimeResponse>({
    queryKey: ['currentTime'],
    queryFn: async () => {
      const response = await fetch(`${apiBase}/api/time`);
      if (!response.ok) {
        throw new Error('Failed to fetch time');
      }
      return response.json();
    },
    refetchInterval: 1000, // Refresh every second
  });

  if (isLoading) {
    return <div className="text-gray-600">Loading time...</div>;
  }

  if (error) {
    return (
      <div className="text-red-600">
        Error fetching time: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="time-display">
      <h2 className="text-lg font-semibold">Current Time</h2>
      <div className="space-y-1 text-sm">
        <div>
          <span className="font-medium">Formatted:</span> {data?.formatted}
        </div>
        <div>
          <span className="font-medium">Timezone:</span> {data?.timezone}
        </div>
        <div>
          <span className="font-medium">Unix:</span> {data?.unix}
        </div>
      </div>
      <button
        onClick={() => refetch()}
        className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:opacity-90"
        data-testid="refresh-button"
      >
        Refresh
      </button>
    </div>
  );
}

/**
 * Main Example route component
 */
function ExampleRoute() {
  const config = (window as any).ELIZA_CONFIG as ElizaConfig | undefined;
  const agentId = config?.agentId;
  const apiBase = config?.apiBase || 'http://localhost:3000';

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

  return <ExampleProvider agentId={agentId as UUID} apiBase={apiBase} />;
}

/**
 * Example provider component
 */
function ExampleProvider({ agentId, apiBase }: { agentId: UUID; apiBase: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-2">Plugin Starter Example</h1>
          <div className="text-sm text-muted-foreground">Agent ID: {agentId}</div>
        </div>
        <TimeDisplay apiBase={apiBase} />
      </div>
    </QueryClientProvider>
  );
}

// Initialize the application - no router needed for iframe
const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<ExampleRoute />);
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

/**
 * Example panel component for the plugin system
 */
const PanelComponent: React.FC<PanelProps> = ({ agentId }) => {
  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-2">Example Panel</h2>
      <div>Hello {agentId}!</div>
    </div>
  );
};

// Export the panel configuration for integration with the agent UI
export const panels: AgentPanel[] = [
  {
    name: 'Example',
    path: 'example',
    component: PanelComponent,
    icon: 'Book',
    public: false,
    shortLabel: 'Example',
  },
];

export * from './utils';
