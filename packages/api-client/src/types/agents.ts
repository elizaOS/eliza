import { UUID } from '@elizaos/core';
import { PaginationParams } from './base';

export interface Agent {
  id: UUID;
  name: string;
  description?: string;
  status: 'active' | 'inactive' | 'stopped';
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
  description?: string;
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
  id: UUID;
  agentId: UUID;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface AgentLogsParams extends PaginationParams {
  level?: 'debug' | 'info' | 'warn' | 'error';
  from?: Date | string;
  to?: Date | string;
  search?: string;
}
