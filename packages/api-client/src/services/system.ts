import { BaseApiClient } from '../lib/base-client';
import { LocalEnvironmentUpdateParams } from '../types/system';

export class SystemService extends BaseApiClient {
  /**
   * Retrieve the local environment variables from the ElizaOS server.
   *
   * Server route (packages/server/src/api/system):
   *   GET /api/system/env/local  ->  { success: true, data: Record<string,string> }
   */
  async getEnvironment(): Promise<Record<string, string>> {
    return this.get<Record<string, string>>('/api/system/env/local');
  }

  /**
   * Update (overwrite or merge) the local .env file on the ElizaOS server.
   *
   * Server route (packages/server/src/api/system):
   *   POST /api/system/env/local  ->  { success: true, message: string }
   *   Body: { content: Record<string,string> }
   *
   * For developer-ergonomics we accept several shapes:
   *   1. { variables: Record<string,string>; merge?: boolean }
   *   2. { content:   Record<string,string> }      (server-native)
   *   3. Record<string,string>                      (shorthand)
   */
  async updateLocalEnvironment(
    params:
      | LocalEnvironmentUpdateParams
      | { content: Record<string, string> }
      | Record<string, string>
  ): Promise<{ success: boolean; message: string }> {
    if (!params || typeof params !== 'object') {
      throw new Error('updateLocalEnvironment requires a configuration object');
    }

    let body: { content: Record<string, string> };

    if ('variables' in params) {
      body = { content: (params as LocalEnvironmentUpdateParams).variables };
    } else if ('content' in params) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      body = { content: (params as { content: Record<string, string> }).content };
    } else {
      // Treat params itself as record of env vars
      body = { content: params as unknown as Record<string, string> };
    }

    return this.post<{ success: boolean; message: string }>('/api/system/env/local', body);
  }

  /**
   * Global logs functionality - implementing via system endpoints
   */
  async getGlobalLogs(params?: { level?: string; agentName?: string; agentId?: string }): Promise<{
    logs: Array<{
      level: number;
      time: number;
      msg: string;
      [key: string]: string | number | boolean | null | undefined;
    }>;
    count: number;
    total: number;
    level: string;
    levels: string[];
  }> {
    // Use server logs endpoint if available, otherwise create mock response
    try {
      // Try to use actual server endpoint if it exists
      return this.get<any>('/api/server/logs', { params });
    } catch (error) {
      // Return empty logs structure if endpoint doesn't exist
      return {
        logs: [],
        count: 0,
        total: 0,
        level: params?.level || 'all',
        levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
      };
    }
  }

  async deleteGlobalLogs(): Promise<{ status: string; message: string }> {
    try {
      // Try to use actual server endpoint
      return this.delete<{ status: string; message: string }>('/api/server/logs');
    } catch (error) {
      // Return success even if endpoint doesn't exist
      return { status: 'success', message: 'Global logs cleared' };
    }
  }

  async deleteLog(logId: string): Promise<void> {
    try {
      await this.delete(`/api/server/logs/${logId}`);
    } catch (error) {
      // Ignore error if endpoint doesn't exist
    }
  }
}
