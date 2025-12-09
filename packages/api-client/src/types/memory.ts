import { UUID } from '@elizaos/core';
import { PaginationParams } from './base';

export interface Memory {
  id: UUID;
  entityId?: UUID;
  agentId: UUID;
  roomId?: UUID;
  type: string;
  content: unknown;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface Room {
  id: UUID;
  agentId: UUID;
  name: string;
  type?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface MemoryParams extends PaginationParams {
  type?: string;
  search?: string;
  from?: Date | string;
  to?: Date | string;
}

export interface MemoryUpdateParams {
  content?: unknown;
  metadata?: Record<string, unknown>;
}

export interface RoomCreateParams {
  name: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

export interface WorldCreateParams {
  messageServerId: UUID;
  name: string;
  description?: string;
}
