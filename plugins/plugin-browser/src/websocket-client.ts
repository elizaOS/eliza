import { logger } from '@elizaos/core';

// Dynamic import to handle both Node.js and bundled environments
let WebSocket: typeof import('ws').default;
if (typeof window !== 'undefined' && typeof window.WebSocket !== 'undefined') {
  // Browser environment
  WebSocket = window.WebSocket as any;
} else {
  // Node.js environment
  WebSocket = require('ws');
}

export interface StagehandMessage {
  type: string;
  requestId?: string;
  [key: string]: any;
}

export class StagehandWebSocketClient {
  private ws: any = null; // Using any to avoid TypeScript issues with ws module
  private messageHandlers = new Map<string, (response: StagehandMessage) => void>();
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(private serverUrl: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new (WebSocket as any)(this.serverUrl);

        this.ws.on('open', () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          logger.info(`[Stagehand] Connected to server at ${this.serverUrl}`);
          resolve();
        });

        this.ws.on('message', (data: any) => {
          try {
            const message = JSON.parse(data.toString()) as StagehandMessage;

            // Handle response messages with requestId
            if (message.requestId && this.messageHandlers.has(message.requestId)) {
              const handler = this.messageHandlers.get(message.requestId)!;
              this.messageHandlers.delete(message.requestId);
              handler(message);
            }

            // Log other messages
            if (message.type === 'connected') {
              logger.info(`[Stagehand] Server connected: ${JSON.stringify(message)}`);
            }
          } catch (error) {
            logger.error('[Stagehand] Error parsing message:', error);
          }
        });

        this.ws.on('error', (error: any) => {
          logger.error('[Stagehand] WebSocket error:', error);
          if (!this.connected) {
            reject(error);
          }
        });

        this.ws.on('close', () => {
          this.connected = false;
          logger.info('[Stagehand] Disconnected from server');

          // Attempt reconnection if not explicitly disconnected
          if (this.ws && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.attemptReconnect();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private async attemptReconnect(): Promise<void> {
    this.reconnectAttempts++;
    logger.info(
      `[Stagehand] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, this.reconnectDelay * this.reconnectAttempts)
    );

    try {
      await this.connect();
    } catch (error) {
      logger.error('[Stagehand] Reconnection failed:', error);
    }
  }

  async sendMessage(type: string, data: any): Promise<StagehandMessage> {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected to Stagehand server');
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const message: StagehandMessage = {
      type,
      requestId,
      ...data,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(requestId);
        reject(new Error(`Request timeout for ${type}`));
      }, 30000); // 30 second timeout

      this.messageHandlers.set(requestId, (response) => {
        clearTimeout(timeout);
        if (response.type === 'error') {
          reject(new Error(response.error || 'Unknown error'));
        } else {
          resolve(response);
        }
      });

      this.ws!.send(JSON.stringify(message));
      logger.debug(`[Stagehand] Sent message: ${type} (${requestId})`);
    });
  }

  disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('[Stagehand] Client disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Convenience methods for specific actions

  async navigate(sessionId: string, url: string): Promise<{ url: string; title: string }> {
    const response = await this.sendMessage('navigate', {
      sessionId,
      data: { url },
    });
    return response.data || { url, title: '' };
  }

  async getState(sessionId: string): Promise<{
    url: string;
    title: string;
    sessionId: string;
    createdAt: Date;
  }> {
    const response = await this.sendMessage('getState', { sessionId });
    return (
      response.data || {
        url: '',
        title: '',
        sessionId,
        createdAt: new Date(),
      }
    );
  }

  async goBack(sessionId: string): Promise<{ url: string; title: string }> {
    const response = await this.sendMessage('goBack', { sessionId });
    return response.data || { url: '', title: '' };
  }

  async goForward(sessionId: string): Promise<{ url: string; title: string }> {
    const response = await this.sendMessage('goForward', { sessionId });
    return response.data || { url: '', title: '' };
  }

  async refresh(sessionId: string): Promise<{ url: string; title: string }> {
    const response = await this.sendMessage('refresh', { sessionId });
    return response.data || { url: '', title: '' };
  }

  async click(sessionId: string, description: string): Promise<StagehandMessage> {
    return await this.sendMessage('click', {
      sessionId,
      data: { description },
    });
  }

  async type(sessionId: string, text: string, field: string): Promise<StagehandMessage> {
    return await this.sendMessage('type', {
      sessionId,
      data: { text, field },
    });
  }

  async select(sessionId: string, option: string, dropdown: string): Promise<StagehandMessage> {
    return await this.sendMessage('select', {
      sessionId,
      data: { option, dropdown },
    });
  }

  async extract(sessionId: string, instruction: string): Promise<StagehandMessage> {
    return await this.sendMessage('extract', {
      sessionId,
      data: { instruction },
    });
  }

  async screenshot(sessionId: string): Promise<StagehandMessage> {
    return await this.sendMessage('screenshot', { sessionId });
  }

  async solveCaptcha(sessionId: string): Promise<StagehandMessage> {
    return await this.sendMessage('solveCaptcha', { sessionId });
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.sendMessage('health', {});
      return response.type === 'health' && response.data?.status === 'ok';
    } catch (error) {
      logger.error('[Stagehand] Health check failed:', error);
      return false;
    }
  }
}
