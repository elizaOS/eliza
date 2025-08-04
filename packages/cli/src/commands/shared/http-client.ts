import type { OptionValues } from 'commander';
import { getAuthHeaders } from './auth-utils';
import { getAgentsBaseUrl } from './url-utils';

/**
 * HTTP client for agent API requests with built-in authentication
 */
export class AgentHttpClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(opts: OptionValues) {
    this.baseUrl = getAgentsBaseUrl(opts);
    this.defaultHeaders = getAuthHeaders(opts);
  }

  /**
   * Merge additional headers with default auth headers
   */
  private mergeHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.defaultHeaders,
      ...additionalHeaders,
    };
  }

  /**
   * GET request
   */
  async get(path: string = '', additionalHeaders?: Record<string, string>): Promise<Response> {
    const url = path ? `${this.baseUrl}/${path}` : this.baseUrl;
    return fetch(url, {
      method: 'GET',
      headers: this.mergeHeaders(additionalHeaders),
    });
  }

  /**
   * POST request
   */
  async post(
    path: string = '',
    body?: any,
    additionalHeaders?: Record<string, string>
  ): Promise<Response> {
    const url = path ? `${this.baseUrl}/${path}` : this.baseUrl;
    const headers = this.mergeHeaders(additionalHeaders);
    
    // Add Content-Type if body is provided and not already set
    if (body && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * PATCH request
   */
  async patch(
    path: string,
    body: any,
    additionalHeaders?: Record<string, string>
  ): Promise<Response> {
    const url = `${this.baseUrl}/${path}`;
    const headers = this.mergeHeaders(additionalHeaders);
    
    // Add Content-Type if not already set
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE request
   */
  async delete(path: string, additionalHeaders?: Record<string, string>): Promise<Response> {
    const url = `${this.baseUrl}/${path}`;
    return fetch(url, {
      method: 'DELETE',
      headers: this.mergeHeaders(additionalHeaders),
    });
  }
}

/**
 * Factory function to create an authenticated HTTP client
 */
export function createAgentHttpClient(opts: OptionValues): AgentHttpClient {
  return new AgentHttpClient(opts);
}