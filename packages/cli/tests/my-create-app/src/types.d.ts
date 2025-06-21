// Global type declarations for the project

export interface ElizaConfig {
  agentId: string;
  apiBase: string;
}

declare global {
  interface Window {
    ELIZA_CONFIG?: ElizaConfig;
  }
}

export {};
