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
} from '../types/sessions';

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
    return this.get<SessionInfoResponse>(`/api/messaging/sessions/${sessionId}`);
  }

  /**
   * Send a message in a session
   * @param sessionId Session ID
   * @param params Message parameters
   * @returns Message response
   */
  async sendMessage(sessionId: string, params: SendMessageParams): Promise<MessageResponse> {
    return this.post<MessageResponse>(`/api/messaging/sessions/${sessionId}/messages`, params);
  }

  /**
   * Get messages from a session
   * @param sessionId Session ID
   * @param params Query parameters for pagination and filtering
   * @returns Messages response
   */
  async getMessages(
    sessionId: string,
    params?: GetMessagesParams
  ): Promise<GetMessagesResponse> {
    const queryParams: Record<string, any> = {};

    if (params?.limit) {
      queryParams.limit = params.limit.toString();
    }

    if (params?.before) {
      if (params.before instanceof Date) {
        queryParams.before = params.before.getTime().toString();
      } else if (typeof params.before === 'string') {
        queryParams.before = new Date(params.before).getTime().toString();
      } else {
        queryParams.before = params.before.toString();
      }
    }

    if (params?.after) {
      if (params.after instanceof Date) {
        queryParams.after = params.after.getTime().toString();
      } else if (typeof params.after === 'string') {
        queryParams.after = new Date(params.after).getTime().toString();
      } else {
        queryParams.after = params.after.toString();
      }
    }

    return this.get<GetMessagesResponse>(
      `/api/messaging/sessions/${sessionId}/messages`,
      { params: queryParams }
    );
  }

  /**
   * Delete a session
   * @param sessionId Session ID
   * @returns Success response
   */
  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
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