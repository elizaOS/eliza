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
    // Special handling for logs endpoint that returns data directly without wrapper
    const response = await fetch(this.buildUrl('/api/server/logs', { params }), {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      logs?: Array<{
        level: number;
        time: number;
        msg: string;
        [key: string]: string | number | boolean | null | undefined;
      }>;
      count?: number;
      total?: number;
      requestedLevel?: string;
      level?: string;
      levels?: string[];
    };

    // The logs endpoint returns data directly, not wrapped in { success, data }
    // Map the response to expected format
    return {
      logs: data.logs || [],
      count: data.count || 0,
      total: data.total || 0,
      level: data.requestedLevel || data.level || 'all',
      levels: data.levels || [],
    };
  }

  private buildUrl(path: string, options?: { params?: Record<string, any> }): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private getHeaders(): Record<string, string> {
    return {
      ...this.defaultHeaders,
    };
  }

  async deleteGlobalLogs(): Promise<{ status: string; message: string }> {
    return this.delete<{ status: string; message: string }>('/api/server/logs');
  }

  async deleteLog(logId: string): Promise<void> {
    // Note: Individual log deletion is not supported by the server
    // The server only supports bulk deletion via deleteGlobalLogs()
    throw new Error(
      'Individual log deletion is not supported. Use deleteGlobalLogs() to clear all logs.'
    );
  }
}
