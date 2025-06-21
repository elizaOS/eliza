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
 * Main Example route component
 */
function ExampleRoute() {
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

  return <ExampleProvider agentId={agentId as UUID} />;
}

/**
 * Example provider component
 */
function ExampleProvider({ agentId }: { agentId: UUID }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div>Hello {agentId}</div>
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
  return <div>Helllo {agentId}!</div>;
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
