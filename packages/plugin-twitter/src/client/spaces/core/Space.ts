// src/core/Space.ts

import { EventEmitter } from 'node:events';
import type { Client } from '../../client';
import { Logger } from '../logger';
import type {
  AudioDataWithUser,
  BroadcastCreated,
  Plugin,
  PluginRegistration,
  SpaceConfig,
  SpeakerInfo,
} from '../types';
import {
  authorizeToken,
  createBroadcast,
  getRegion,
  getTurnServers,
  muteSpeaker,
  publishBroadcast,
  setupCommonChatEvents,
  unmuteSpeaker,
} from '../utils';
import { ChatClient } from './ChatClient';
import { JanusClient } from './JanusClient';

/**
 * Manages the creation of a new Space (broadcast host):
 * 1) Creates the broadcast on Periscope
 * 2) Sets up Janus WebRTC for audio
 * 3) Optionally creates a ChatClient for interactive mode
 * 4) Allows managing (approve/remove) speakers, pushing audio, etc.
 */
/**
 * Represents a space that can be used for communication and collaboration.
 * Extends the EventEmitter class and contains properties for debugging, logging, Janus client, chat client, authentication token,
 * and broadcast information.
 */
export class Space extends EventEmitter {
  private readonly debug: boolean;
  private readonly logger: Logger;

  private janusClient?: JanusClient;
  private chatClient?: ChatClient;

  private authToken?: string;
  private broadcastInfo?: BroadcastCreated;
  private isInitialized = false;

  private plugins = new Set<PluginRegistration>();
  private speakers = new Map<string, SpeakerInfo>();

  constructor(
    private readonly client: Client,
    options?: { debug?: boolean }
  ) {
    super();
    this.debug = options?.debug ?? false;
    this.logger = new Logger(this.debug);
  }

  /**
   * Registers a plugin and calls its onAttach(...).
   * init(...) will be invoked once initialization is complete.
   */
  public use(plugin: Plugin, config?: Record<string, any>) {
    const registration: PluginRegistration = { plugin, config };
    this.plugins.add(registration);

    this.logger.debug('[Space] Plugin added =>', plugin.constructor.name);
    plugin.onAttach?.({ space: this, pluginConfig: config });

    // If we've already initialized this Space, immediately call plugin.init(...)
    if (this.isInitialized && plugin.init) {
      plugin.init({ space: this, pluginConfig: config });
      // If Janus is also up, call onJanusReady
      if (this.janusClient) {
        plugin.onJanusReady?.(this.janusClient);
      }
    }

    return this;
  }

  /**
   * Main entry point to create and initialize the Space broadcast.
   */
  public async initialize(config: SpaceConfig) {
    this.logger.debug('[Space] Initializing...');

    // 1) Obtain the Periscope cookie + region
    const cookie = await this.client.getPeriscopeCookie();
    const region = await getRegion();
    this.logger.debug('[Space] Got region =>', region);

    // 2) Create a broadcast
    this.logger.debug('[Space] Creating broadcast...');
    const broadcast = await createBroadcast({
      description: config.description,
      languages: config.languages,
      cookie,
      region,
      record: config.record,
    });
    this.broadcastInfo = broadcast;

    // 3) Authorize to get an auth token
    this.logger.debug('[Space] Authorizing token...');
    this.authToken = await authorizeToken(cookie);

    // 4) Gather TURN servers
    this.logger.debug('[Space] Getting turn servers...');
    const turnServers = await getTurnServers(cookie);

    // 5) Create and initialize Janus for hosting
    this.janusClient = new JanusClient({
      webrtcUrl: broadcast.webrtc_gw_url,
      roomId: broadcast.room_id,
      credential: broadcast.credential,
      userId: broadcast.broadcast.user_id,
      streamName: broadcast.stream_name,
      turnServers,
      logger: this.logger,
    });
    await this.janusClient.initialize();

    // Forward PCM from Janus to plugin.onAudioData
    this.janusClient.on('audioDataFromSpeaker', (data: AudioDataWithUser) => {
      this.logger.debug('[Space] Received PCM from speaker =>', data.userId);
      this.handleAudioData(data);
    });

    // Update speaker info once we subscribe
    this.janusClient.on('subscribedSpeaker', ({ userId, feedId }) => {
      const speaker = this.speakers.get(userId);
      if (!speaker) {
        this.logger.debug('[Space] subscribedSpeaker => no speaker found', userId);
        return;
      }
      speaker.janusParticipantId = feedId;
      this.logger.debug(`[Space] updated speaker => userId=${userId}, feedId=${feedId}`);
    });

    // 6) Publish the broadcast so it's live
    this.logger.debug('[Space] Publishing broadcast...');
    await publishBroadcast({
      title: config.title || '',
      broadcast,
      cookie,
      janusSessionId: this.janusClient.getSessionId(),
      janusHandleId: this.janusClient.getHandleId(),
      janusPublisherId: this.janusClient.getPublisherId(),
    });

    // 7) If interactive => set up ChatClient
    if (config.mode === 'INTERACTIVE') {
      this.logger.debug('[Space] Connecting chat...');
      this.chatClient = new ChatClient({
        spaceId: broadcast.room_id,
        accessToken: broadcast.access_token,
        endpoint: broadcast.endpoint,
        logger: this.logger,
      });
      await this.chatClient.connect();
      this.setupChatEvents();
    }

    this.logger.info('[Space] Initialized =>', broadcast.share_url.replace('broadcasts', 'spaces'));
    this.isInitialized = true;

    // Call plugin.init(...) and onJanusReady(...) for all plugins now that we're set
    for (const { plugin, config: pluginConfig } of this.plugins) {
      plugin.init?.({ space: this, pluginConfig });
      plugin.onJanusReady?.(this.janusClient);
    }

    this.logger.debug('[Space] All plugins initialized');
    return broadcast;
  }

  /**
   * Send an emoji reaction via chat, if interactive.
   */
  public reactWithEmoji(emoji: string) {
    if (!this.chatClient) return;
    this.chatClient.reactWithEmoji(emoji);
  }

  /**
   * Internal method to wire up chat events if interactive.
   */
  private setupChatEvents() {
    if (!this.chatClient) return;
    setupCommonChatEvents(this.chatClient, this.logger, this);
  }

  /**
   * Approves a speaker request on Twitter side, then calls Janus to subscribe their audio.
   */
  public async approveSpeaker(userId: string, sessionUUID: string) {
    if (!this.isInitialized || !this.broadcastInfo) {
      throw new Error('[Space] Not initialized or missing broadcastInfo');
    }
    if (!this.authToken) {
      throw new Error('[Space] No auth token available');
    }

    // Store in our local speaker map
    this.speakers.set(userId, { userId, sessionUUID });

    // 1) Call Twitter's /request/approve
    await this.callApproveEndpoint(this.broadcastInfo, this.authToken, userId, sessionUUID);

    // 2) Subscribe to their audio in Janus
    await this.janusClient?.subscribeSpeaker(userId);
  }

  /**
   * Approve request => calls /api/v1/audiospace/request/approve
   */
  private async callApproveEndpoint(
    broadcast: BroadcastCreated,
    authorizationToken: string,
    userId: string,
    sessionUUID: string
  ): Promise<void> {
    const endpoint = 'https://guest.pscp.tv/api/v1/audiospace/request/approve';
    const headers = {
      'Content-Type': 'application/json',
      Referer: 'https://x.com/',
      Authorization: authorizationToken,
    };
    const body = {
      ntpForBroadcasterFrame: '2208988800024000300',
      ntpForLiveFrame: '2208988800024000300',
      chat_token: broadcast.access_token,
      session_uuid: sessionUUID,
    };

    this.logger.debug('[Space] Approving speaker =>', endpoint, body);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`[Space] Failed to approve speaker => ${resp.status}: ${error}`);
    }

    this.logger.info('[Space] Speaker approved =>', userId);
  }

  /**
   * Removes a speaker from the Twitter side, then unsubscribes in Janus if needed.
   */
  public async removeSpeaker(userId: string) {
    if (!this.isInitialized || !this.broadcastInfo) {
      throw new Error('[Space] Not initialized or missing broadcastInfo');
    }
    if (!this.authToken) {
      throw new Error('[Space] No auth token');
    }
    if (!this.janusClient) {
      throw new Error('[Space] No Janus client');
    }

    // Find this speaker in local map
    const speaker = this.speakers.get(userId);
    if (!speaker) {
      throw new Error(`[Space] removeSpeaker => no speaker found for userId=${userId}`);
    }

    const { sessionUUID, janusParticipantId } = speaker;
    this.logger.debug('[Space] removeSpeaker =>', sessionUUID, janusParticipantId, speaker);

    if (!sessionUUID || janusParticipantId === undefined) {
      throw new Error(
        `[Space] removeSpeaker => missing sessionUUID or feedId for userId=${userId}`
      );
    }

    // 1) Eject on Twitter side
    const janusHandleId = this.janusClient.getHandleId();
    const janusSessionId = this.janusClient.getSessionId();
    if (!janusHandleId || !janusSessionId) {
      throw new Error(`[Space] removeSpeaker => missing Janus handle/session for userId=${userId}`);
    }

    await this.callRemoveEndpoint(
      this.broadcastInfo,
      this.authToken,
      sessionUUID,
      janusParticipantId,
      this.broadcastInfo.room_id,
      janusHandleId,
      janusSessionId
    );

    // 2) Remove from local map
    this.speakers.delete(userId);
    this.logger.info(`[Space] removeSpeaker => removed userId=${userId}`);
  }

  /**
   * Twitter's /api/v1/audiospace/stream/eject call
   */
  private async callRemoveEndpoint(
    broadcast: BroadcastCreated,
    authorizationToken: string,
    sessionUUID: string,
    janusParticipantId: number,
    janusRoomId: string,
    webrtcHandleId: number,
    webrtcSessionId: number
  ): Promise<void> {
    const endpoint = 'https://guest.pscp.tv/api/v1/audiospace/stream/eject';
    const headers = {
      'Content-Type': 'application/json',
      Referer: 'https://x.com/',
      Authorization: authorizationToken,
    };
    const body = {
      ntpForBroadcasterFrame: '2208988800024000300',
      ntpForLiveFrame: '2208988800024000300',
      session_uuid: sessionUUID,
      chat_token: broadcast.access_token,
      janus_room_id: janusRoomId,
      janus_participant_id: janusParticipantId,
      webrtc_handle_id: webrtcHandleId,
      webrtc_session_id: webrtcSessionId,
    };

    this.logger.debug('[Space] Removing speaker =>', endpoint, body);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`[Space] Failed to remove speaker => ${resp.status}: ${error}`);
    }

    this.logger.debug('[Space] Speaker removed => sessionUUID=', sessionUUID);
  }

  /**
   * Push PCM audio frames if you're the host. Usually you'd do this if you're capturing
   * microphone input from the host side.
   */
  public pushAudio(samples: Int16Array, sampleRate: number) {
    this.janusClient?.pushLocalAudio(samples, sampleRate);
  }

  /**
   * Handler for PCM from other speakers, forwarded to plugin.onAudioData
   */
  private handleAudioData(data: AudioDataWithUser) {
    for (const { plugin } of this.plugins) {
      plugin.onAudioData?.(data);
    }
  }

  /**
   * Gracefully shut down this Space: destroy the Janus room, end the broadcast, etc.
   */
  public async finalizeSpace(): Promise<void> {
    this.logger.info('[Space] finalizeSpace => stopping broadcast gracefully');

    const tasks: Array<Promise<any>> = [];

    if (this.janusClient) {
      tasks.push(
        this.janusClient.destroyRoom().catch((err) => {
          this.logger.error('[Space] destroyRoom error =>', err);
        })
      );
    }

    if (this.broadcastInfo) {
      tasks.push(
        this.endAudiospace({
          broadcastId: this.broadcastInfo.room_id,
          chatToken: this.broadcastInfo.access_token,
        }).catch((err) => {
          this.logger.error('[Space] endAudiospace error =>', err);
        })
      );
    }

    if (this.janusClient) {
      tasks.push(
        this.janusClient.leaveRoom().catch((err) => {
          this.logger.error('[Space] leaveRoom error =>', err);
        })
      );
    }

    await Promise.all(tasks);
    this.logger.info('[Space] finalizeSpace => done.');
  }

  /**
   * Calls /api/v1/audiospace/admin/endAudiospace on Twitter side.
   */
  private async endAudiospace(params: { broadcastId: string; chatToken: string }): Promise<void> {
    const url = 'https://guest.pscp.tv/api/v1/audiospace/admin/endAudiospace';
    const headers = {
      'Content-Type': 'application/json',
      Referer: 'https://x.com/',
      Authorization: this.authToken || '',
    };
    const body = {
      broadcast_id: params.broadcastId,
      chat_token: params.chatToken,
    };

    this.logger.debug('[Space] endAudiospace =>', body);

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`[Space] endAudiospace => ${resp.status} ${errText}`);
    }

    const json = await resp.json();
    this.logger.debug('[Space] endAudiospace => success =>', json);
  }

  /**
   * Retrieves an array of known speakers in this Space (by userId and sessionUUID).
   */
  public getSpeakers(): SpeakerInfo[] {
    return Array.from(this.speakers.values());
  }

  /**
   * Mute the host (yourself). For the host, session_uuid = '' (empty).
   */
  public async muteHost() {
    if (!this.authToken) {
      throw new Error('[Space] No auth token available');
    }
    if (!this.broadcastInfo) {
      throw new Error('[Space] No broadcastInfo');
    }

    await muteSpeaker({
      broadcastId: this.broadcastInfo.room_id,
      sessionUUID: '', // host => empty
      chatToken: this.broadcastInfo.access_token,
      authToken: this.authToken,
    });
    this.logger.info('[Space] Host muted successfully.');
  }

  /**
   * Unmute the host (yourself).
   */
  public async unmuteHost() {
    if (!this.authToken) {
      throw new Error('[Space] No auth token');
    }
    if (!this.broadcastInfo) {
      throw new Error('[Space] No broadcastInfo');
    }

    await unmuteSpeaker({
      broadcastId: this.broadcastInfo.room_id,
      sessionUUID: '',
      chatToken: this.broadcastInfo.access_token,
      authToken: this.authToken,
    });
    this.logger.info('[Space] Host unmuted successfully.');
  }

  /**
   * Mute a specific speaker. We'll retrieve sessionUUID from our local map.
   */
  public async muteSpeaker(userId: string) {
    if (!this.authToken) {
      throw new Error('[Space] No auth token available');
    }
    if (!this.broadcastInfo) {
      throw new Error('[Space] No broadcastInfo');
    }

    const speaker = this.speakers.get(userId);
    if (!speaker) {
      throw new Error(`[Space] Speaker not found for userId=${userId}`);
    }

    await muteSpeaker({
      broadcastId: this.broadcastInfo.room_id,
      sessionUUID: speaker.sessionUUID,
      chatToken: this.broadcastInfo.access_token,
      authToken: this.authToken,
    });
    this.logger.info(`[Space] Muted speaker => userId=${userId}`);
  }

  /**
   * Unmute a specific speaker. We'll retrieve sessionUUID from local map.
   */
  public async unmuteSpeaker(userId: string) {
    if (!this.authToken) {
      throw new Error('[Space] No auth token available');
    }
    if (!this.broadcastInfo) {
      throw new Error('[Space] No broadcastInfo');
    }

    const speaker = this.speakers.get(userId);
    if (!speaker) {
      throw new Error(`[Space] Speaker not found for userId=${userId}`);
    }

    await unmuteSpeaker({
      broadcastId: this.broadcastInfo.room_id,
      sessionUUID: speaker.sessionUUID,
      chatToken: this.broadcastInfo.access_token,
      authToken: this.authToken,
    });
    this.logger.info(`[Space] Unmuted speaker => userId=${userId}`);
  }

  /**
   * Stop the broadcast entirely, performing finalizeSpace() plus plugin cleanup.
   */
  public async stop() {
    this.logger.info('[Space] Stopping...');

    await this.finalizeSpace().catch((err) => {
      this.logger.error('[Space] finalizeBroadcast error =>', err);
    });

    // Disconnect chat if present
    if (this.chatClient) {
      await this.chatClient.disconnect();
      this.chatClient = undefined;
    }

    // Stop Janus if running
    if (this.janusClient) {
      await this.janusClient.stop();
      this.janusClient = undefined;
    }

    // Cleanup all plugins
    for (const { plugin } of this.plugins) {
      plugin.cleanup?.();
    }
    this.plugins.clear();

    this.isInitialized = false;
  }
}
