import { UUID } from '@elizaos/core';
import { PaginationParams } from './base';

export interface Memory {
  id: UUID;
  agentId: UUID;
  roomId?: UUID;
  type: string;
  content: any;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface Room {
  id: UUID;
  agentId: UUID;
  name: string;
  type?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface MemoryParams extends PaginationParams {
  type?: string;
  search?: string;
  from?: Date | string;
  to?: Date | string;
}

export interface MemoryUpdateParams {
  content?: any;
  metadata?: Record<string, any>;
}

export interface RoomCreateParams {
  name: string;
  type?: string;
  metadata?: Record<string, any>;
}

export interface WorldCreateParams {
  serverId: UUID;
  name: string;
  description?: string;
}
