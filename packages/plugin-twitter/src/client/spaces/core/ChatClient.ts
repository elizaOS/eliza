// src/core/ChatClient.ts

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../logger';
import type { OccupancyUpdate, SpeakerRequest } from '../types';

/**
 * Configuration object for ChatClient.
 */
/**
 * @typedef {Object} ChatClientConfig
 * @property {string} spaceId - The space ID (e.g., "1vOGwAbcdE...") for this audio space.
 * @property {string} accessToken - The access token obtained from accessChat or the live_video_stream/status.
 * @property {string} endpoint - The endpoint host for the chat server (e.g., "https://prod-chatman-ancillary-eu-central-1.pscp.tv").
 * @property {Logger} logger - An instance of Logger for debug/info logs.
 */
interface ChatClientConfig {
  /**
   * The space ID (e.g., "1vOGwAbcdE...") for this audio space.
   */
  spaceId: string;

  /**
   * The access token obtained from accessChat or the live_video_stream/status.
   */
  accessToken: string;

  /**
   * The endpoint host for the chat server (e.g., "https://prod-chatman-ancillary-eu-central-1.pscp.tv").
   */
  endpoint: string;

  /**
   * An instance of Logger for debug/info logs.
   */
  logger: Logger;
}

/**
 * ChatClient handles the WebSocket connection to the Twitter/Periscope chat API.
 * It emits events such as "speakerRequest", "occupancyUpdate", "muteStateChanged", etc.
 */
export class ChatClient extends EventEmitter {
  private ws?: WebSocket;
  private connected = false;

  private readonly logger: Logger;
  private readonly spaceId: string;
  private readonly accessToken: string;
  private endpoint: string;

  constructor(config: ChatClientConfig) {
    super();
    this.spaceId = config.spaceId;
    this.accessToken = config.accessToken;
    this.endpoint = config.endpoint;
    this.logger = config.logger;
  }

  /**
   * Establishes a WebSocket connection to the chat endpoint and sets up event handlers.
   */
  public async connect(): Promise<void> {
    const wsUrl = `${this.endpoint}/chatapi/v1/chatnow`.replace('https://', 'wss://');
    this.logger.info('[ChatClient] Connecting =>', wsUrl);

    this.ws = new WebSocket(wsUrl, {
      headers: {
        Origin: 'https://x.com',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    await this.setupHandlers();
  }

  /**
   * Internal method to set up WebSocket event listeners (open, message, close, error).
   */
  private setupHandlers(): Promise<void> {
    if (!this.ws) {
      throw new Error('[ChatClient] No WebSocket instance available');
    }

    return new Promise((resolve, reject) => {
      this.ws?.on('open', () => {
        this.logger.info('[ChatClient] Connected');
        this.connected = true;
        this.sendAuthAndJoin();
        resolve();
      });

      this.ws?.on('message', (data: { toString: () => string }) => {
        this.handleMessage(data.toString());
      });

      this.ws?.on('close', () => {
        this.logger.info('[ChatClient] Closed');
        this.connected = false;
        this.emit('disconnected');
      });

      this.ws?.on('error', (err) => {
        this.logger.error('[ChatClient] Error =>', err);
        reject(err);
      });
    });
  }

  /**
   * Sends two WebSocket messages to authenticate and join the specified space.
   */
  private sendAuthAndJoin(): void {
    if (!this.ws) return;

    // 1) Send authentication (access token)
    this.ws.send(
      JSON.stringify({
        payload: JSON.stringify({ access_token: this.accessToken }),
        kind: 3,
      })
    );

    // 2) Send a "join" message specifying the room (space ID)
    this.ws.send(
      JSON.stringify({
        payload: JSON.stringify({
          body: JSON.stringify({ room: this.spaceId }),
          kind: 1,
        }),
        kind: 2,
      })
    );
  }

  /**
   * Sends an emoji reaction to the chat server.
   * @param emoji - The emoji string, e.g. '🔥', '🙏', etc.
   */
  public reactWithEmoji(emoji: string): void {
    if (!this.ws || !this.connected) {
      this.logger.warn('[ChatClient] Not connected or WebSocket missing; ignoring reactWithEmoji.');
      return;
    }

    const payload = JSON.stringify({
      body: JSON.stringify({ body: emoji, type: 2, v: 2 }),
      kind: 1,
      /*
      // The 'sender' field is not required, it's not even verified by the server
      // Instead of passing attributes down here it's easier to ignore it
      sender: {
        user_id: null,
        twitter_id: null,
        username: null,
        display_name: null,
      },
      */
      payload: JSON.stringify({
        room: this.spaceId,
        body: JSON.stringify({ body: emoji, type: 2, v: 2 }),
      }),
      type: 2,
    });

    this.ws.send(payload);
  }

  /**
   * Handles inbound WebSocket messages, parsing JSON payloads
   * and emitting relevant events (speakerRequest, occupancyUpdate, etc.).
   */
  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Invalid JSON, ignoring
    }
    if (!msg.payload) return;

    const payload = safeJson(msg.payload);
    if (!payload?.body) return;

    const body = safeJson(payload.body);

    // 1) Speaker request => "guestBroadcastingEvent=1"
    if (body.guestBroadcastingEvent === 1) {
      const req: SpeakerRequest = {
        userId: body.guestRemoteID,
        username: body.guestUsername,
        displayName: payload.sender?.display_name || body.guestUsername,
        sessionUUID: body.sessionUUID,
      };
      this.emit('speakerRequest', req);
    }

    // 2) Occupancy update => body.occupancy
    if (typeof body.occupancy === 'number') {
      const update: OccupancyUpdate = {
        occupancy: body.occupancy,
        totalParticipants: body.total_participants || 0,
      };
      this.emit('occupancyUpdate', update);
    }

    // 3) Mute/unmute => "guestBroadcastingEvent=16" (mute) or "17" (unmute)
    if (body.guestBroadcastingEvent === 16) {
      this.emit('muteStateChanged', {
        userId: body.guestRemoteID,
        muted: true,
      });
    }
    if (body.guestBroadcastingEvent === 17) {
      this.emit('muteStateChanged', {
        userId: body.guestRemoteID,
        muted: false,
      });
    }

    // 4) "guestBroadcastingEvent=12" => host accepted a speaker
    if (body.guestBroadcastingEvent === 12) {
      this.emit('newSpeakerAccepted', {
        userId: body.guestRemoteID,
        username: body.guestUsername,
        sessionUUID: body.sessionUUID,
      });
    }

    // 5) "guestBroadcastingEvent=10" => host removed a speaker
    if (body.guestBroadcastingEvent === 10) {
      this.emit('newSpeakerRemoved', {
        userId: body.guestRemoteID,
        username: body.guestUsername,
        sessionUUID: body.sessionUUID,
      });
    }

    // 6) Reaction => body.type=2
    if (body?.type === 2) {
      this.logger.debug('[ChatClient] Emitting guestReaction =>', body);
      this.emit('guestReaction', {
        displayName: body.displayName,
        emoji: body.body,
      });
    }
  }

  /**
   * Closes the WebSocket connection if open, and resets internal state.
   */
  public async disconnect(): Promise<void> {
    if (this.ws) {
      this.logger.info('[ChatClient] Disconnecting...');
      this.ws.close();
      this.ws = undefined;
      this.connected = false;
    }
  }
}

/**
 * Helper function to safely parse JSON without throwing.
 */
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
