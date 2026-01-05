import { BaseApiClient } from '../lib/base-client';
import type {
  CreateSessionParams,
  CreateSessionResponse,
  SendMessageParams,
  GetMessagesParams,
  GetMessagesResponse,
  SessionInfoResponse,
  SessionsHealthResponse,
  ListSessionsResponse,
  MessageResponse,
  TransportType,
} from '../types/sessions';

/**
 * Query parameters for session messages API
 */
interface SessionMessageQueryParams {
  limit?: string;
  before?: string;
  after?: string;
}

/**
 * Validates and converts a date parameter to timestamp string
 * @param value Date, string, or number to convert
 * @param paramName Name of the parameter for error messages
 * @returns Timestamp string or undefined if value is invalid
 */
function toTimestampString(
  value: Date | string | number | undefined,
  paramName: string
): string | undefined {
  if (!value) {
    return undefined;
  }

  let timestamp: number;

  if (value instanceof Date) {
    timestamp = value.getTime();
  } else if (typeof value === 'string') {
    const date = new Date(value);
    timestamp = date.getTime();

    // Check for invalid date
    if (isNaN(timestamp)) {
      console.warn(`Invalid date string for ${paramName}: ${value}`);
      return undefined;
    }
  } else if (typeof value === 'number') {
    timestamp = value;
  } else {
    console.warn(`Invalid type for ${paramName}: ${typeof value}`);
    return undefined;
  }

  return timestamp.toString();
}

/**
 * Validates required parameters
 * @param value Parameter value to validate
 * @param paramName Name of the parameter for error messages
 * @throws Error if the parameter is invalid
 */
function validateRequiredParam(
  value: string | undefined | null,
  paramName: string
): asserts value is string {
  if (!value || value.trim() === '') {
    throw new Error(`${paramName} is required and cannot be empty`);
  }
}

/**
 * Service for managing messaging sessions between users and agents
 */
export class SessionsService extends BaseApiClient {
  /**
   * Get health status of the sessions service
   * @returns Health check response
   */
  async checkHealth(): Promise<SessionsHealthResponse> {
    return this.get<SessionsHealthResponse>('/api/messaging/sessions/health');
  }

  /**
   * Create a new messaging session
   * @param params Session creation parameters
   * @returns Created session response
   */
  async createSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
    return this.post<CreateSessionResponse>('/api/messaging/sessions', params);
  }

  /**
   * Get session details
   * @param sessionId Session ID
   * @returns Session information
   */
  async getSession(sessionId: string): Promise<SessionInfoResponse> {
    validateRequiredParam(sessionId, 'sessionId');
    return this.get<SessionInfoResponse>(`/api/messaging/sessions/${sessionId}`);
  }

  /**
   * Send a message in a session
   * @param sessionId Session ID
   * @param params Message parameters (includes optional transport: 'http' | 'sse' | 'websocket')
   * @returns Message response with userMessage and optional agentResponse (in http mode)
   *
   * @example
   * // Default websocket transport - returns immediately
   * const response = await sessions.sendMessage(sessionId, { content: 'Hello' });
   * console.log(response.userMessage.id);
   *
   * @example
   * // HTTP transport - waits for agent response
   * const response = await sessions.sendMessage(sessionId, {
   *   content: 'Hello',
   *   transport: 'http'
   * });
   * console.log(response.agentResponse?.text);
   */
  async sendMessage(sessionId: string, params: SendMessageParams): Promise<MessageResponse> {
    validateRequiredParam(sessionId, 'sessionId');
    validateRequiredParam(params?.content, 'content');
    return this.post<MessageResponse>(`/api/messaging/sessions/${sessionId}/messages`, params);
  }

  /**
   * Send a message and wait for the agent's response (HTTP transport)
   * Convenience method that sets transport to 'http'
   * @param sessionId Session ID
   * @param params Message parameters
   * @returns Message response with agentResponse included
   */
  async sendMessageSync(
    sessionId: string,
    params: Omit<SendMessageParams, 'transport'>
  ): Promise<MessageResponse> {
    return this.sendMessage(sessionId, { ...params, transport: 'http' as TransportType });
  }

  /**
   * Get messages from a session
   * @param sessionId Session ID
   * @param params Query parameters for pagination and filtering
   * @returns Messages response
   */
  async getMessages(sessionId: string, params?: GetMessagesParams): Promise<GetMessagesResponse> {
    validateRequiredParam(sessionId, 'sessionId');

    const queryParams: SessionMessageQueryParams = {};

    if (params?.limit) {
      queryParams.limit = params.limit.toString();
    }

    // Convert date parameters with validation
    const beforeTimestamp = toTimestampString(params?.before, 'before');
    if (beforeTimestamp) {
      queryParams.before = beforeTimestamp;
    }

    const afterTimestamp = toTimestampString(params?.after, 'after');
    if (afterTimestamp) {
      queryParams.after = afterTimestamp;
    }

    return this.get<GetMessagesResponse>(`/api/messaging/sessions/${sessionId}/messages`, {
      params: queryParams,
    });
  }

  /**
   * Delete a session
   * @param sessionId Session ID
   * @returns Success response
   */
  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    validateRequiredParam(sessionId, 'sessionId');
    return this.delete<{ success: boolean }>(`/api/messaging/sessions/${sessionId}`);
  }

  /**
   * List all active sessions (admin endpoint)
   * @returns List of active sessions
   */
  async listSessions(): Promise<ListSessionsResponse> {
    return this.get<ListSessionsResponse>('/api/messaging/sessions');
  }
}
