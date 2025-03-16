// src/core/SpaceParticipant.ts

import { EventEmitter } from 'node:events';
import type { Client } from '../../client';
import { Logger } from '../logger';
import type { AudioDataWithUser, Plugin, PluginRegistration, TurnServersInfo } from '../types';
import {
  accessChat,
  authorizeToken,
  cancelSpeakerRequest,
  getTurnServers,
  muteSpeaker,
  negotiateGuestStream,
  setupCommonChatEvents,
  startWatching,
  stopWatching,
  submitSpeakerRequest,
  unmuteSpeaker,
} from '../utils';
import { ChatClient } from './ChatClient';
import { JanusClient } from './JanusClient';

/**
 * Interface representing the configuration options for a space participant.
 * @typedef {object} SpaceParticipantConfig
 * @property {string} spaceId - The unique identifier for the space.
 * @property {boolean} [debug] - Optional flag for enabling debug mode.
 */
interface SpaceParticipantConfig {
  spaceId: string;
  debug?: boolean;
}

/**
 * Manages joining an existing Space in listener mode,
 * and optionally becoming a speaker via WebRTC (Janus).
 */
/**
 * Class representing a participant in a space.
 * @extends EventEmitter
 */
export class SpaceParticipant extends EventEmitter {
  private readonly spaceId: string;
  private readonly debug: boolean;
  private readonly logger: Logger;

  // Basic auth/cookie data
  private cookie?: string;
  private authToken?: string;

  // Chat
  private chatJwtToken?: string;
  private chatToken?: string;
  private chatClient?: ChatClient;

  // Watch session
  private lifecycleToken?: string;
  private watchSession?: string;

  // HLS stream
  private hlsUrl?: string;

  // Speaker request + Janus
  private sessionUUID?: string;
  private janusJwt?: string;
  private webrtcGwUrl?: string;
  private janusClient?: JanusClient;

  // Plugin management
  private plugins = new Set<PluginRegistration>();

  constructor(
    private readonly client: Client,
    config: SpaceParticipantConfig
  ) {
    super();
    this.spaceId = config.spaceId;
    this.debug = config.debug ?? false;
    this.logger = new Logger(this.debug);
  }

  /**
   * Adds a plugin and calls its onAttach immediately.
   * init() or onJanusReady() will be invoked later at the appropriate time.
   */
  public use(plugin: Plugin, config?: Record<string, any>) {
    const registration: PluginRegistration = { plugin, config };
    this.plugins.add(registration);

    this.logger.debug('[SpaceParticipant] Plugin added =>', plugin.constructor.name);

    // Call the plugin's onAttach if it exists
    plugin.onAttach?.({ space: this, pluginConfig: config });

    if (plugin.init) {
      plugin.init({ space: this, pluginConfig: config });
    }

    return this;
  }

  /**
   * Joins the Space as a listener: obtains HLS, chat token, etc.
   */
  public async joinAsListener(): Promise<void> {
    this.logger.info('[SpaceParticipant] Joining space as listener =>', this.spaceId);

    // 1) Get cookie and authorize
    this.cookie = await this.client.getPeriscopeCookie();
    this.authToken = await authorizeToken(this.cookie);

    // 2) Retrieve the space metadata for mediaKey
    const spaceMeta = await this.client.getAudioSpaceById(this.spaceId);
    const mediaKey = spaceMeta?.metadata?.media_key;
    if (!mediaKey) {
      throw new Error('[SpaceParticipant] No mediaKey found in metadata');
    }
    this.logger.debug('[SpaceParticipant] mediaKey =>', mediaKey);

    // 3) Query live_video_stream/status for HLS URL and chat token
    const status = await this.client.getAudioSpaceStreamStatus(mediaKey);
    this.hlsUrl = status?.source?.location;
    this.chatJwtToken = status?.chatToken;
    this.lifecycleToken = status?.lifecycleToken;
    this.logger.debug('[SpaceParticipant] HLS =>', this.hlsUrl);

    // 4) Access the chat
    if (!this.chatJwtToken) {
      throw new Error('[SpaceParticipant] No chatToken found');
    }
    const chatInfo = await accessChat(this.chatJwtToken, this.cookie!);
    this.chatToken = chatInfo.access_token;

    // 5) Create and connect the ChatClient
    this.chatClient = new ChatClient({
      spaceId: chatInfo.room_id,
      accessToken: chatInfo.access_token,
      endpoint: chatInfo.endpoint,
      logger: this.logger,
    });
    await this.chatClient.connect();
    this.setupChatEvents();

    // 6) startWatching (to appear as a viewer)
    this.watchSession = await startWatching(this.lifecycleToken!, this.cookie!);

    this.logger.info('[SpaceParticipant] Joined as listener.');
  }

  /**
   * Returns the HLS URL if you want to consume the stream as a listener.
   */
  public getHlsUrl(): string | undefined {
    return this.hlsUrl;
  }

  /**
   * Submits a speaker request using /audiospace/request/submit.
   * Returns the sessionUUID used to track approval.
   */
  public async requestSpeaker(): Promise<{ sessionUUID: string }> {
    if (!this.chatJwtToken) {
      throw new Error('[SpaceParticipant] Must join as listener first (no chat token).');
    }
    if (!this.authToken) {
      throw new Error('[SpaceParticipant] No auth token available.');
    }
    if (!this.chatToken) {
      throw new Error('[SpaceParticipant] No chat token available.');
    }

    this.logger.info('[SpaceParticipant] Submitting speaker request...');

    const { session_uuid } = await submitSpeakerRequest({
      broadcastId: this.spaceId,
      chatToken: this.chatToken,
      authToken: this.authToken,
    });
    this.sessionUUID = session_uuid;

    this.logger.info('[SpaceParticipant] Speaker request submitted =>', session_uuid);
    return { sessionUUID: session_uuid };
  }

  /**
   * Cancels a previously submitted speaker request using /audiospace/request/cancel.
   * This requires a valid sessionUUID from requestSpeaker() first.
   */
  public async cancelSpeakerRequest(): Promise<void> {
    if (!this.sessionUUID) {
      throw new Error(
        '[SpaceParticipant] No sessionUUID; cannot cancel a speaker request that was never submitted.'
      );
    }
    if (!this.authToken) {
      throw new Error('[SpaceParticipant] No auth token available.');
    }
    if (!this.chatToken) {
      throw new Error('[SpaceParticipant] No chat token available.');
    }

    await cancelSpeakerRequest({
      broadcastId: this.spaceId,
      sessionUUID: this.sessionUUID,
      chatToken: this.chatToken,
      authToken: this.authToken,
    });

    this.logger.info('[SpaceParticipant] Speaker request canceled =>', this.sessionUUID);
    this.sessionUUID = undefined;
  }

  /**
   * Once the host approves our speaker request, we perform Janus negotiation
   * to become a speaker.
   */
  public async becomeSpeaker(): Promise<void> {
    if (!this.sessionUUID) {
      throw new Error('[SpaceParticipant] No sessionUUID (did you call requestSpeaker()?).');
    }
    this.logger.info('[SpaceParticipant] Negotiating speaker role via Janus...');

    // 1) Retrieve TURN servers
    const turnServers: TurnServersInfo = await getTurnServers(this.cookie!);
    this.logger.debug('[SpaceParticipant] turnServers =>', turnServers);

    // 2) Negotiate with /audiospace/stream/negotiate
    const nego = await negotiateGuestStream({
      broadcastId: this.spaceId,
      sessionUUID: this.sessionUUID,
      authToken: this.authToken!,
      cookie: this.cookie!,
    });
    this.janusJwt = nego.janus_jwt;
    this.webrtcGwUrl = nego.webrtc_gw_url;
    this.logger.debug('[SpaceParticipant] webrtcGwUrl =>', this.webrtcGwUrl);

    // 3) Create JanusClient
    this.janusClient = new JanusClient({
      webrtcUrl: this.webrtcGwUrl!,
      roomId: this.spaceId,
      credential: this.janusJwt!,
      userId: turnServers.username.split(':')[1],
      streamName: this.spaceId,
      turnServers,
      logger: this.logger,
    });

    // 4) Initialize the guest speaker session in Janus
    await this.janusClient.initializeGuestSpeaker(this.sessionUUID);

    this.janusClient.on('audioDataFromSpeaker', (data: AudioDataWithUser) => {
      this.logger.debug('[SpaceParticipant] Received speaker audio =>', data.userId);
      this.handleAudioData(data);
    });

    this.logger.info('[SpaceParticipant] Now speaker on the Space =>', this.spaceId);

    // For plugins that need direct Janus references, call onJanusReady
    for (const { plugin } of this.plugins) {
      plugin.onJanusReady?.(this.janusClient);
    }
  }

  /**
   * Removes self from the speaker role and transitions back to a listener.
   */
  public async removeFromSpeaker(): Promise<void> {
    if (!this.sessionUUID) {
      throw new Error('[SpaceParticipant] No sessionUUID; cannot remove from speaker role.');
    }
    if (!this.authToken || !this.chatToken) {
      throw new Error('[SpaceParticipant] Missing authToken or chatToken.');
    }

    this.logger.info('[SpaceParticipant] Removing from speaker role...');

    // Stop the Janus session
    if (this.janusClient) {
      await this.janusClient.stop();
      this.janusClient = undefined;
    }

    this.logger.info('[SpaceParticipant] Successfully removed from speaker role.');
  }

  /**
   * Leaves the Space gracefully:
   * - Stop Janus if we were a speaker
   * - Stop watching as a viewer
   * - Disconnect chat
   */
  public async leaveSpace(): Promise<void> {
    this.logger.info('[SpaceParticipant] Leaving space...');

    // If speaker, stop Janus
    if (this.janusClient) {
      await this.janusClient.stop();
      this.janusClient = undefined;
    }

    // Stop watching
    if (this.watchSession && this.cookie) {
      await stopWatching(this.watchSession, this.cookie);
    }

    // Disconnect chat
    if (this.chatClient) {
      await this.chatClient.disconnect();
      this.chatClient = undefined;
    }

    this.logger.info('[SpaceParticipant] Left space =>', this.spaceId);
  }

  /**
   * Pushes PCM audio frames if we're speaker; otherwise logs a warning.
   */
  public pushAudio(samples: Int16Array, sampleRate: number) {
    if (!this.janusClient) {
      this.logger.warn('[SpaceParticipant] Not a speaker yet; ignoring pushAudio.');
      return;
    }
    this.janusClient.pushLocalAudio(samples, sampleRate);
  }

  /**
   * Internal handler for incoming PCM frames from Janus, forwarded to plugin.onAudioData if present.
   */
  private handleAudioData(data: AudioDataWithUser) {
    for (const { plugin } of this.plugins) {
      plugin.onAudioData?.(data);
    }
  }

  /**
   * Sets up chat events: "occupancyUpdate", "newSpeakerAccepted", etc.
   */
  private setupChatEvents() {
    if (!this.chatClient) return;
    setupCommonChatEvents(this.chatClient, this.logger, this);

    this.chatClient.on('newSpeakerAccepted', ({ userId }) => {
      this.logger.debug('[SpaceParticipant] newSpeakerAccepted =>', userId);

      // If we haven't created Janus yet, skip
      if (!this.janusClient) {
        this.logger.warn('[SpaceParticipant] No janusClient yet; ignoring new speaker...');
        return;
      }
      // If this is our own handle, skip
      if (userId === this.janusClient.getHandleId()) {
        return;
      }

      // Subscribe to this new speaker's audio
      this.janusClient.subscribeSpeaker(userId).catch((err) => {
        this.logger.error('[SpaceParticipant] subscribeSpeaker error =>', err);
      });
    });
  }

  /**
   * Mute self if we are speaker: calls /audiospace/muteSpeaker with our sessionUUID.
   */
  public async muteSelf(): Promise<void> {
    if (!this.authToken || !this.chatToken) {
      throw new Error('[SpaceParticipant] Missing authToken or chatToken.');
    }
    if (!this.sessionUUID) {
      throw new Error('[SpaceParticipant] No sessionUUID; are you a speaker?');
    }

    await muteSpeaker({
      broadcastId: this.spaceId,
      sessionUUID: this.sessionUUID,
      chatToken: this.chatToken,
      authToken: this.authToken,
    });
    this.logger.info('[SpaceParticipant] Successfully muted self.');
  }

  /**
   * Unmute self if we are speaker: calls /audiospace/unmuteSpeaker with our sessionUUID.
   */
  public async unmuteSelf(): Promise<void> {
    if (!this.authToken || !this.chatToken) {
      throw new Error('[SpaceParticipant] Missing authToken or chatToken.');
    }
    if (!this.sessionUUID) {
      throw new Error('[SpaceParticipant] No sessionUUID; are you a speaker?');
    }

    await unmuteSpeaker({
      broadcastId: this.spaceId,
      sessionUUID: this.sessionUUID,
      chatToken: this.chatToken,
      authToken: this.authToken,
    });
    this.logger.info('[SpaceParticipant] Successfully unmuted self.');
  }
}
