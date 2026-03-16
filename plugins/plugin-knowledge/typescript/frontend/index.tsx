import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "./index.css";
import type { UUID } from "@elizaos/core";
import React from "react";
import { KnowledgeTab } from "./ui/knowledge-tab.tsx";

const queryClient = new QueryClient();

interface ElizaConfig {
  agentId: string;
  apiBase: string;
}

declare global {
  interface Window {
    ELIZA_CONFIG?: ElizaConfig;
  }
}

function KnowledgeRoute() {
  const config = window.ELIZA_CONFIG;
  const agentId = config?.agentId;

  React.useEffect(() => {
    document.documentElement.classList.add("dark");
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

function KnowledgeProvider({ agentId }: { agentId: UUID }) {
  return (
    <QueryClientProvider client={queryClient}>
      <KnowledgeTab agentId={agentId} />
    </QueryClientProvider>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<KnowledgeRoute />);
}

export interface AgentPanel {
  name: string;
  path: string;
  component: React.ComponentType<Record<string, unknown>>;
  icon?: string;
  public?: boolean;
  shortLabel?: string;
}

interface KnowledgePanelProps extends Record<string, string> {
  agentId: string;
}

const KnowledgePanelComponent: React.FC<KnowledgePanelProps> = ({ agentId }) => {
  return <KnowledgeTab agentId={agentId as UUID} />;
};

export const panels: AgentPanel[] = [
  {
    name: "Knowledge",
    path: "knowledge",
    component: KnowledgePanelComponent as React.ComponentType<Record<string, unknown>>,
    icon: "Book",
    public: false,
    shortLabel: "Know",
  },
];

export * from "./utils";
