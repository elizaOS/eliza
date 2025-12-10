import { UUID, Agent } from '@elizaos/core';
import { PaginationParams } from './base';

// Re-export Agent from core
export type { Agent } from '@elizaos/core';

export interface AgentCreateParams {
  characterPath?: string;
  characterJson?: Record<string, unknown>;
  agent?: Agent;
}

export interface AgentUpdateParams {
  name?: string;
  bio?: string | string[];
  metadata?: Record<string, unknown>;
}

export interface AgentWorld {
  id: UUID;
  name: string;
  description?: string;
  agents?: Agent[];
}

export interface AgentWorldSettings {
  worldId: UUID;
  settings: Record<string, unknown>;
}

export interface AgentPanel {
  id: string;
  name: string;
  url: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface AgentLog {
  id?: UUID;
  type?: string;
  timestamp?: number;
  message?: string;
  details?: string;
  roomId?: UUID;
  body?: {
    modelType?: string;
    modelKey?: string;
    params?: unknown;
    response?: unknown;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  createdAt?: number;
  [key: string]: unknown;
}

export interface AgentLogsParams extends PaginationParams {
  level?: 'debug' | 'info' | 'warn' | 'error';
  from?: Date | string;
  to?: Date | string;
  search?: string;
}
