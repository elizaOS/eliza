import { BaseApiClient } from '../lib/base-client';
import { ServerHealth, ServerStatus, ServerDebugInfo, LogSubmitParams } from '../types/server';

export class ServerService extends BaseApiClient {
  /**
   * Health check
   */
  async checkHealth(): Promise<ServerHealth> {
    return this.get<ServerHealth>('/api/server/health');
  }

  /**
   * Simple ping
   */
  async ping(): Promise<{ pong: boolean }> {
    return this.get<{ pong: boolean }>('/api/server/ping');
  }

  /**
   * Hello endpoint
   */
  async hello(): Promise<{ message: string }> {
    return this.get<{ message: string }>('/api/server/hello');
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<ServerStatus> {
    return this.get<ServerStatus>('/api/server/status');
  }

  /**
   * Stop the server
   */
  async stopServer(): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>('/api/server/stop');
  }

  /**
   * Get runtime debug info
   */
  async getDebugInfo(): Promise<ServerDebugInfo> {
    return this.get<ServerDebugInfo>('/api/server/debug/servers');
  }

  /**
   * Submit logs
   */
  async submitLogs(logs: LogSubmitParams[]): Promise<{ received: number }> {
    return this.post<{ received: number }>('/api/server/logs', { logs });
  }

  /**
   * Clear logs
   */
  async clearLogs(): Promise<{ cleared: number }> {
    return this.delete<{ cleared: number }>('/api/server/logs');
  }
}
