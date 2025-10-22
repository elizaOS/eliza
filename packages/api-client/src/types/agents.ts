import { UUID } from '@elizaos/core';
import { PaginationParams } from './base';

export interface Agent {
  id: UUID;
  name: string;
  bio?: string | string[];
  status: 'active' | 'inactive' | 'stopped';
  enabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface AgentCreateParams {
  characterPath?: string;
  characterJson?: Record<string, any>;
  agent?: Record<string, any>;
}

export interface AgentUpdateParams {
  name?: string;
  bio?: string | string[];
  metadata?: Record<string, any>;
}

export interface AgentWorld {
  id: UUID;
  name: string;
  description?: string;
  agents?: Agent[];
}

export interface AgentWorldSettings {
  worldId: UUID;
  settings: Record<string, any>;
}

export interface AgentPanel {
  id: string;
  name: string;
  url: string;
  type: string;
  metadata?: Record<string, any>;
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
    params?: any;
    response?: any;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  createdAt?: number;
  [key: string]: any;
}

export interface AgentLogsParams extends PaginationParams {
  level?: 'debug' | 'info' | 'warn' | 'error';
  from?: Date | string;
  to?: Date | string;
  search?: string;
}
