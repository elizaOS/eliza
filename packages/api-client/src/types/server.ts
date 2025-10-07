import { UUID } from '@elizaos/core';

export interface ServerHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  timestamp: Date;
  version?: string;
  checks?: Record<
    string,
    {
      status: 'pass' | 'fail';
      message?: string;
    }
  >;
}

export interface ServerStatus {
  agents: {
    total: number;
    active: number;
    inactive: number;
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  uptime: number;
  version: string;
}

export interface ServerDebugInfo {
  runtime: {
    agents: Array<{
      id: UUID;
      name: string;
      status: string;
    }>;
    connections: number;
    memory: any;
  };
  environment: Record<string, string>;
}

export interface LogSubmitParams {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  metadata?: Record<string, any>;
}
