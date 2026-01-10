import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import './index.css';
import React from 'react';
import { KnowledgeTab } from './ui/knowledge-tab.tsx';
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
 * Main Knowledge route component
 */
function KnowledgeRoute() {
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

  return <KnowledgeProvider agentId={agentId as UUID} />;
}

/**
 * Knowledge provider component
 */
function KnowledgeProvider({ agentId }: { agentId: UUID }) {
  return (
    <QueryClientProvider client={queryClient}>
      <KnowledgeTab agentId={agentId} />
    </QueryClientProvider>
  );
}

// Initialize the application - no router needed for iframe
const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<KnowledgeRoute />);
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

interface KnowledgePanelProps {
  agentId: string;
}

/**
 * Knowledge panel component for the plugin system
 */
const KnowledgePanelComponent: React.FC<KnowledgePanelProps> = ({ agentId }) => {
  return <KnowledgeTab agentId={agentId as UUID} />;
};

// Export the panel configuration for integration with the agent UI
export const panels: AgentPanel[] = [
  {
    name: 'Knowledge',
    path: 'knowledge',
    component: KnowledgePanelComponent,
    icon: 'Book',
    public: false,
    shortLabel: 'Know',
  },
];

export * from './utils';
