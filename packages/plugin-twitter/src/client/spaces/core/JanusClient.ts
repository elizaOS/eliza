// src/core/JanusClient.ts

import { EventEmitter } from 'node:events';
import wrtc from '@roamhq/wrtc';
const { RTCPeerConnection, MediaStream } = wrtc;
import type { Logger } from '../logger';
import type { AudioDataWithUser, TurnServersInfo } from '../types';
import { JanusAudioSink, JanusAudioSource } from './JanusAudio';

/**
 * Interface representing the configuration settings for the Janus gateway.
 * @typedef {Object} JanusConfig
 * @property {string} webrtcUrl - The base URL for the Janus gateway.
 * @property {string} roomId - The unique room ID.
 * @property {string} credential - The token/credential used to authorize requests to Janus.
 * @property {string} userId - The user identifier (host or speaker).
 * @property {string} streamName - The name of the stream.
 * @property {TurnServersInfo} turnServers - ICE/TURN server information returned by Twitter's /turnServers endpoint.
 * @property {Logger} logger - Logger instance for consistent debug/info/error logs.
 */
interface JanusConfig {
  /**
   * The base URL for the Janus gateway (e.g. "https://gw-prod-hydra-eu-west-3.pscp.tv/s=prod:XX/v1/gateway")
   */
  webrtcUrl: string;

  /**
   * The unique room ID (e.g., the broadcast or space ID)
   */
  roomId: string;

  /**
   * The token/credential used to authorize requests to Janus (often a signed JWT).
   */
  credential: string;

  /**
   * The user identifier (host or speaker). Used as 'display' in the Janus plugin.
   */
  userId: string;

  /**
   * The name of the stream (often the same as roomId for convenience).
   */
  streamName: string;

  /**
   * ICE / TURN server information returned by Twitter's /turnServers endpoint.
   */
  turnServers: TurnServersInfo;

  /**
   * Logger instance for consistent debug/info/error logs.
   */
  logger: Logger;
}

/**
 * Manages the Janus session for a Twitter AudioSpace:
 *  - Creates a Janus session and plugin handle
 *  - Joins the Janus videoroom as publisher/subscriber
 *  - Subscribes to other speakers
 *  - Sends local PCM frames as Opus
 *  - Polls for Janus events
 *
 * It can be used by both the host (who creates a room) or a guest speaker (who joins an existing room).
 */
export class JanusClient extends EventEmitter {
  private logger: Logger;

  private sessionId?: number;
  private handleId?: number;
  private publisherId?: number;

  private pc?: RTCPeerConnection;
  private localAudioSource?: JanusAudioSource;

  private pollActive = false;

  // Tracks promises waiting for specific Janus events
  private eventWaiters: Array<{
    predicate: (evt: any) => boolean;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];

  // Tracks subscriber handle+pc for each userId we subscribe to
  private subscribers = new Map<
    string,
    {
      handleId: number;
      pc: RTCPeerConnection;
    }
  >();

  constructor(private readonly config: JanusConfig) {
    super();
    this.logger = config.logger;
  }

  /**
   * Initializes this JanusClient for the host scenario:
   *  1) createSession()
   *  2) attachPlugin()
   *  3) createRoom()
   *  4) joinRoom()
   *  5) configure local PeerConnection (send audio, etc.)
   */
  public async initialize(): Promise<void> {
    this.logger.debug('[JanusClient] initialize() called');

    this.sessionId = await this.createSession();
    this.handleId = await this.attachPlugin();

    // Start polling for Janus events
    this.pollActive = true;
    this.startPolling();

    // Create a new Janus room (only for the host scenario)
    await this.createRoom();

    // Join that room as publisher
    this.publisherId = await this.joinRoom();

    // Set up our RTCPeerConnection for local audio
    this.pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: this.config.turnServers.uris,
          username: this.config.turnServers.username,
          credential: this.config.turnServers.password,
        },
      ],
    });
    this.setupPeerEvents();

    // Add local audio track
    this.enableLocalAudio();

    // Create an offer and configure the publisher in Janus
    await this.configurePublisher();

    this.logger.info('[JanusClient] Initialization complete');
  }

  /**
   * Initializes this JanusClient for a guest speaker scenario:
   *  1) createSession()
   *  2) attachPlugin()
   *  3) join existing room as publisher (no createRoom call)
   *  4) configure local PeerConnection
   *  5) subscribe to any existing publishers
   */
  public async initializeGuestSpeaker(sessionUUID: string): Promise<void> {
    this.logger.debug('[JanusClient] initializeGuestSpeaker() called');

    // 1) Create a new Janus session
    this.sessionId = await this.createSession();
    this.handleId = await this.attachPlugin();

    // Start polling
    this.pollActive = true;
    this.startPolling();

    // 2) Join the existing room as a publisher (no createRoom)
    const evtPromise = this.waitForJanusEvent(
      (e) =>
        e.janus === 'event' &&
        e.plugindata?.plugin === 'janus.plugin.videoroom' &&
        e.plugindata?.data?.videoroom === 'joined',
      10000,
      'Guest Speaker joined event'
    );

    const body = {
      request: 'join',
      room: this.config.roomId,
      ptype: 'publisher',
      display: this.config.userId,
      periscope_user_id: this.config.userId,
    };
    await this.sendJanusMessage(this.handleId, body);

    // Wait for the joined event
    const evt = await evtPromise;
    const data = evt.plugindata?.data;
    this.publisherId = data.id; // Our own publisherId
    this.logger.debug('[JanusClient] guest joined => publisherId=', this.publisherId);

    // If there are existing publishers, we can subscribe to them
    const publishers = data.publishers || [];
    this.logger.debug('[JanusClient] existing publishers =>', publishers);

    // 3) Create RTCPeerConnection for sending local audio
    this.pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: this.config.turnServers.uris,
          username: this.config.turnServers.username,
          credential: this.config.turnServers.password,
        },
      ],
    });
    this.setupPeerEvents();
    this.enableLocalAudio();

    // 4) configurePublisher => generate offer, wait for answer
    await this.configurePublisher(sessionUUID);

    // 5) Subscribe to each existing publisher
    await Promise.all(publishers.map((pub: any) => this.subscribeSpeaker(pub.display, pub.id)));

    this.logger.info('[JanusClient] Guest speaker negotiation complete');
  }

  /**
   * Subscribes to a speaker's audio feed by userId and/or feedId.
   * If feedId=0, we wait for a "publishers" event to discover feedId.
   */
  public async subscribeSpeaker(userId: string, feedId = 0): Promise<void> {
    this.logger.debug('[JanusClient] subscribeSpeaker => userId=', userId);

    // 1) Attach a separate plugin handle for subscriber
    const subscriberHandleId = await this.attachPlugin();
    this.logger.debug('[JanusClient] subscriber handle =>', subscriberHandleId);

    // If feedId was not provided, wait for an event listing publishers
    if (feedId === 0) {
      const publishersEvt = await this.waitForJanusEvent(
        (e) =>
          e.janus === 'event' &&
          e.plugindata?.plugin === 'janus.plugin.videoroom' &&
          e.plugindata?.data?.videoroom === 'event' &&
          Array.isArray(e.plugindata?.data?.publishers) &&
          e.plugindata?.data?.publishers.length > 0,
        8000,
        'discover feed_id from "publishers"'
      );

      const list = publishersEvt.plugindata.data.publishers as any[];
      const pub = list.find((p) => p.display === userId || p.periscope_user_id === userId);
      if (!pub) {
        throw new Error(
          `[JanusClient] subscribeSpeaker => No publisher found for userId=${userId}`
        );
      }
      feedId = pub.id;
      this.logger.debug('[JanusClient] found feedId =>', feedId);
    }

    // Notify listeners that we've discovered a feed
    this.emit('subscribedSpeaker', { userId, feedId });

    // 2) Join the room as a "subscriber"
    const joinBody = {
      request: 'join',
      room: this.config.roomId,
      periscope_user_id: this.config.userId,
      ptype: 'subscriber',
      streams: [
        {
          feed: feedId,
          mid: '0',
          send: true, // indicates we might send audio?
        },
      ],
    };
    await this.sendJanusMessage(subscriberHandleId, joinBody);

    // 3) Wait for "attached" + jsep.offer
    const attachedEvt = await this.waitForJanusEvent(
      (e) =>
        e.janus === 'event' &&
        e.sender === subscriberHandleId &&
        e.plugindata?.plugin === 'janus.plugin.videoroom' &&
        e.plugindata?.data?.videoroom === 'attached' &&
        e.jsep?.type === 'offer',
      8000,
      'subscriber attached + offer'
    );
    this.logger.debug('[JanusClient] subscriber => "attached" with offer');

    // 4) Create a new RTCPeerConnection for receiving audio from this feed
    const offer = attachedEvt.jsep;
    const subPc = new RTCPeerConnection({
      iceServers: [
        {
          urls: this.config.turnServers.uris,
          username: this.config.turnServers.username,
          credential: this.config.turnServers.password,
        },
      ],
    });

    subPc.ontrack = (evt) => {
      this.logger.debug(
        '[JanusClient] subscriber track => kind=%s, readyState=%s, muted=%s',
        evt.track.kind,
        evt.track.readyState,
        evt.track.muted
      );
      // Attach a JanusAudioSink to capture PCM
      const sink = new JanusAudioSink(evt.track, { logger: this.logger });

      // For each audio frame, forward it to 'audioDataFromSpeaker'
      sink.on('audioData', (frame) => {
        if (this.logger.isDebugEnabled()) {
          let maxVal = 0;
          for (let i = 0; i < frame.samples.length; i++) {
            const val = Math.abs(frame.samples[i]);
            if (val > maxVal) maxVal = val;
          }
          this.logger.debug(`[AudioSink] userId=${userId}, maxAmplitude=${maxVal}`);
        }

        this.emit('audioDataFromSpeaker', {
          userId,
          bitsPerSample: frame.bitsPerSample,
          sampleRate: frame.sampleRate,
          numberOfFrames: frame.numberOfFrames,
          channelCount: frame.channelCount,
          samples: frame.samples,
        } as AudioDataWithUser);
      });
    };

    // 5) Answer the subscription offer
    await subPc.setRemoteDescription(offer);
    const answer = await subPc.createAnswer();
    await subPc.setLocalDescription(answer);

    // 6) Send "start" request to begin receiving
    await this.sendJanusMessage(
      subscriberHandleId,
      {
        request: 'start',
        room: this.config.roomId,
        periscope_user_id: this.config.userId,
      },
      answer
    );

    this.logger.debug('[JanusClient] subscriber => done (user=', userId, ')');

    // Track this subscription handle+pc by userId
    this.subscribers.set(userId, { handleId: subscriberHandleId, pc: subPc });
  }

  /**
   * Pushes local PCM frames to Janus. If the localAudioSource isn't active, it enables it.
   */
  public pushLocalAudio(samples: Int16Array, sampleRate: number, channels = 1) {
    if (!this.localAudioSource) {
      this.logger.warn('[JanusClient] No localAudioSource => enabling now...');
      this.enableLocalAudio();
    }
    this.localAudioSource?.pushPcmData(samples, sampleRate, channels);
  }

  /**
   * Ensures a local audio track is added to the RTCPeerConnection for publishing.
   */
  public enableLocalAudio(): void {
    if (!this.pc) {
      this.logger.warn('[JanusClient] enableLocalAudio => No RTCPeerConnection');
      return;
    }
    if (this.localAudioSource) {
      this.logger.debug('[JanusClient] localAudioSource already active');
      return;
    }
    // Create a JanusAudioSource that feeds PCM frames
    this.localAudioSource = new JanusAudioSource({ logger: this.logger });
    const track = this.localAudioSource.getTrack();
    const localStream = new MediaStream();
    localStream.addTrack(track);
    this.pc.addTrack(track, localStream);
  }

  /**
   * Stops the Janus client: ends polling, closes the RTCPeerConnection, etc.
   * Does not destroy or leave the room automatically; call destroyRoom() or leaveRoom() if needed.
   */
  public async stop(): Promise<void> {
    this.logger.info('[JanusClient] Stopping...');
    this.pollActive = false;
    if (this.pc) {
      this.pc.close();
      this.pc = undefined;
    }
  }

  /**
   * Returns the current Janus sessionId, if any.
   */
  public getSessionId(): number | undefined {
    return this.sessionId;
  }

  /**
   * Returns the Janus handleId for the publisher, if any.
   */
  public getHandleId(): number | undefined {
    return this.handleId;
  }

  /**
   * Returns the Janus publisherId (internal participant ID), if any.
   */
  public getPublisherId(): number | undefined {
    return this.publisherId;
  }

  /**
   * Creates a new Janus session via POST /janus (with "janus":"create").
   */
  private async createSession(): Promise<number> {
    const transaction = this.randomTid();
    const resp = await fetch(this.config.webrtcUrl, {
      method: 'POST',
      headers: {
        Authorization: this.config.credential,
        'Content-Type': 'application/json',
        Referer: 'https://x.com',
      },
      body: JSON.stringify({
        janus: 'create',
        transaction,
      }),
    });
    if (!resp.ok) {
      throw new Error('[JanusClient] createSession failed');
    }
    const json = await resp.json();
    if (json.janus !== 'success') {
      throw new Error('[JanusClient] createSession invalid response');
    }
    return json.data.id;
  }

  /**
   * Attaches to the videoroom plugin via /janus/{sessionId} (with "janus":"attach").
   */
  private async attachPlugin(): Promise<number> {
    if (!this.sessionId) {
      throw new Error('[JanusClient] attachPlugin => no sessionId');
    }
    const transaction = this.randomTid();
    const resp = await fetch(`${this.config.webrtcUrl}/${this.sessionId}`, {
      method: 'POST',
      headers: {
        Authorization: this.config.credential,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        janus: 'attach',
        plugin: 'janus.plugin.videoroom',
        transaction,
      }),
    });
    if (!resp.ok) {
      throw new Error('[JanusClient] attachPlugin failed');
    }
    const json = await resp.json();
    if (json.janus !== 'success') {
      throw new Error('[JanusClient] attachPlugin invalid response');
    }
    return json.data.id;
  }

  /**
   * Creates a Janus room for the host scenario.
   * For a guest, this step is skipped (the room already exists).
   */
  private async createRoom(): Promise<void> {
    if (!this.sessionId || !this.handleId) {
      throw new Error('[JanusClient] createRoom => No session/handle');
    }
    const transaction = this.randomTid();
    const body = {
      request: 'create',
      room: this.config.roomId,
      periscope_user_id: this.config.userId,
      audiocodec: 'opus',
      videocodec: 'h264',
      transport_wide_cc_ext: true,
      app_component: 'audio-room',
      h264_profile: '42e01f',
      dummy_publisher: false,
    };
    const resp = await fetch(`${this.config.webrtcUrl}/${this.sessionId}/${this.handleId}`, {
      method: 'POST',
      headers: {
        Authorization: this.config.credential,
        'Content-Type': 'application/json',
        Referer: 'https://x.com',
      },
      body: JSON.stringify({
        janus: 'message',
        transaction,
        body,
      }),
    });
    if (!resp.ok) {
      throw new Error(`[JanusClient] createRoom failed => ${resp.status}`);
    }
    const json = await resp.json();
    this.logger.debug('[JanusClient] createRoom =>', JSON.stringify(json));

    if (json.janus === 'error') {
      throw new Error(`[JanusClient] createRoom error => ${json.error?.reason || 'Unknown'}`);
    }
    if (json.plugindata?.data?.videoroom !== 'created') {
      throw new Error(`[JanusClient] unexpected createRoom response => ${JSON.stringify(json)}`);
    }
    this.logger.debug(`[JanusClient] Room '${this.config.roomId}' created successfully`);
  }

  /**
   * Joins the created room as a publisher, for the host scenario.
   */
  private async joinRoom(): Promise<number> {
    if (!this.sessionId || !this.handleId) {
      throw new Error('[JanusClient] no session/handle for joinRoom()');
    }

    this.logger.debug('[JanusClient] joinRoom => start');

    // Wait for the 'joined' event from videoroom
    const evtPromise = this.waitForJanusEvent(
      (e) =>
        e.janus === 'event' &&
        e.plugindata?.plugin === 'janus.plugin.videoroom' &&
        e.plugindata?.data?.videoroom === 'joined',
      12000,
      'Host Joined Event'
    );

    const body = {
      request: 'join',
      room: this.config.roomId,
      ptype: 'publisher',
      display: this.config.userId,
      periscope_user_id: this.config.userId,
    };
    await this.sendJanusMessage(this.handleId, body);

    const evt = await evtPromise;
    const publisherId = evt.plugindata.data.id;
    this.logger.debug('[JanusClient] joined room => publisherId=', publisherId);
    return publisherId;
  }

  /**
   * Creates an SDP offer and sends "configure" to Janus with it.
   * Used by both host and guest after attach + join.
   */
  private async configurePublisher(sessionUUID = ''): Promise<void> {
    if (!this.pc || !this.sessionId || !this.handleId) {
      return;
    }

    this.logger.debug('[JanusClient] createOffer...');
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await this.pc.setLocalDescription(offer);

    this.logger.debug('[JanusClient] sending configure with JSEP...');
    await this.sendJanusMessage(
      this.handleId,
      {
        request: 'configure',
        room: this.config.roomId,
        periscope_user_id: this.config.userId,
        session_uuid: sessionUUID,
        stream_name: this.config.streamName,
        vidman_token: this.config.credential,
      },
      offer
    );
    this.logger.debug('[JanusClient] waiting for answer...');
  }

  /**
   * Sends a "janus":"message" to the Janus handle, optionally with jsep.
   */
  private async sendJanusMessage(handleId: number, body: any, jsep?: any): Promise<void> {
    if (!this.sessionId) {
      throw new Error('[JanusClient] No session for sendJanusMessage');
    }
    const transaction = this.randomTid();
    const resp = await fetch(`${this.config.webrtcUrl}/${this.sessionId}/${handleId}`, {
      method: 'POST',
      headers: {
        Authorization: this.config.credential,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        janus: 'message',
        transaction,
        body,
        jsep,
      }),
    });
    if (!resp.ok) {
      throw new Error(`[JanusClient] sendJanusMessage failed => status=${resp.status}`);
    }
  }

  /**
   * Starts polling /janus/{sessionId}?maxev=1 for events. We parse keepalives, answers, etc.
   */
  private startPolling(): void {
    this.logger.debug('[JanusClient] Starting polling...');
    const doPoll = async () => {
      if (!this.pollActive || !this.sessionId) {
        this.logger.debug('[JanusClient] Polling stopped');
        return;
      }
      try {
        const url = `${this.config.webrtcUrl}/${this.sessionId}?maxev=1&_=${Date.now()}`;
        const resp = await fetch(url, {
          headers: { Authorization: this.config.credential },
        });
        if (resp.ok) {
          const event = await resp.json();
          this.handleJanusEvent(event);
        } else {
          this.logger.warn('[JanusClient] poll error =>', resp.status);
        }
      } catch (err) {
        this.logger.error('[JanusClient] poll exception =>', err);
      }
      setTimeout(doPoll, 500);
    };
    doPoll();
  }

  /**
   * Processes each Janus event received from the poll cycle.
   */
  private handleJanusEvent(evt: any): void {
    if (!evt.janus) {
      return;
    }
    if (evt.janus === 'keepalive') {
      this.logger.debug('[JanusClient] keepalive received');
      return;
    }
    if (evt.janus === 'webrtcup') {
      this.logger.debug('[JanusClient] webrtcup => sender=', evt.sender);
    }
    // If there's a JSEP answer, set it on our RTCPeerConnection
    if (evt.jsep && evt.jsep.type === 'answer') {
      this.onReceivedAnswer(evt.jsep);
    }
    // If there's a publisherId in the data, store it
    if (evt.plugindata?.data?.id) {
      this.publisherId = evt.plugindata.data.id;
    }
    // If there's an error, emit an 'error' event
    if (evt.error) {
      this.logger.error('[JanusClient] Janus error =>', evt.error.reason);
      this.emit('error', new Error(evt.error.reason));
    }

    // Resolve any waiting eventWaiters whose predicate matches
    for (let i = 0; i < this.eventWaiters.length; i++) {
      const waiter = this.eventWaiters[i];
      if (waiter.predicate(evt)) {
        this.eventWaiters.splice(i, 1);
        waiter.resolve(evt);
        break;
      }
    }
  }

  /**
   * Called whenever we get an SDP "answer" from Janus. Sets the remote description on our PC.
   */
  private async onReceivedAnswer(answer: any): Promise<void> {
    if (!this.pc) {
      return;
    }
    this.logger.debug('[JanusClient] got answer => setRemoteDescription');
    await this.pc.setRemoteDescription(answer);
  }

  /**
   * Sets up events on our main RTCPeerConnection for ICE changes, track additions, etc.
   */
  private setupPeerEvents(): void {
    if (!this.pc) {
      return;
    }
    this.pc.addEventListener('iceconnectionstatechange', () => {
      this.logger.debug('[JanusClient] ICE state =>', this.pc?.iceConnectionState);
      if (this.pc?.iceConnectionState === 'failed') {
        this.emit('error', new Error('[JanusClient] ICE connection failed'));
      }
    });
    this.pc.addEventListener('track', (evt) => {
      this.logger.debug('[JanusClient] ontrack => kind=', evt.track.kind);
    });
  }

  /**
   * Generates a random transaction ID for Janus requests.
   */
  private randomTid(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /**
   * Waits for a specific Janus event (e.g., "joined", "attached", etc.)
   * that matches a given predicate. Times out after timeoutMs if not received.
   */
  private async waitForJanusEvent(
    predicate: (evt: any) => boolean,
    timeoutMs = 5000,
    description = 'some event'
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      this.eventWaiters.push(waiter);

      setTimeout(() => {
        const idx = this.eventWaiters.indexOf(waiter);
        if (idx !== -1) {
          this.eventWaiters.splice(idx, 1);
          this.logger.warn(
            `[JanusClient] waitForJanusEvent => timed out waiting for: ${description}`
          );
          reject(
            new Error(
              `[JanusClient] waitForJanusEvent (expecting "${description}") timed out after ${timeoutMs}ms`
            )
          );
        }
      }, timeoutMs);
    });
  }

  /**
   * Destroys the Janus room (host only). Does not close local PC or stop polling.
   */
  public async destroyRoom(): Promise<void> {
    if (!this.sessionId || !this.handleId) {
      this.logger.warn('[JanusClient] destroyRoom => no session/handle');
      return;
    }
    if (!this.config.roomId || !this.config.userId) {
      this.logger.warn('[JanusClient] destroyRoom => no roomId/userId');
      return;
    }

    const transaction = this.randomTid();
    const body = {
      request: 'destroy',
      room: this.config.roomId,
      periscope_user_id: this.config.userId,
    };
    this.logger.info('[JanusClient] destroying room =>', body);

    const resp = await fetch(`${this.config.webrtcUrl}/${this.sessionId}/${this.handleId}`, {
      method: 'POST',
      headers: {
        Authorization: this.config.credential,
        'Content-Type': 'application/json',
        Referer: 'https://x.com',
      },
      body: JSON.stringify({
        janus: 'message',
        transaction,
        body,
      }),
    });
    if (!resp.ok) {
      throw new Error(`[JanusClient] destroyRoom failed => ${resp.status}`);
    }
    const json = await resp.json();
    this.logger.debug('[JanusClient] destroyRoom =>', JSON.stringify(json));
  }

  /**
   * Leaves the Janus room if we've joined. Does not close the local PC or stop polling.
   */
  public async leaveRoom(): Promise<void> {
    if (!this.sessionId || !this.handleId) {
      this.logger.warn('[JanusClient] leaveRoom => no session/handle');
      return;
    }
    const transaction = this.randomTid();
    const body = {
      request: 'leave',
      room: this.config.roomId,
      periscope_user_id: this.config.userId,
    };
    this.logger.info('[JanusClient] leaving room =>', body);

    const resp = await fetch(`${this.config.webrtcUrl}/${this.sessionId}/${this.handleId}`, {
      method: 'POST',
      headers: {
        Authorization: this.config.credential,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        janus: 'message',
        transaction,
        body,
      }),
    });
    if (!resp.ok) {
      throw new Error(`[JanusClient] leaveRoom => error code ${resp.status}`);
    }
    const json = await resp.json();
    this.logger.debug('[JanusClient] leaveRoom =>', JSON.stringify(json));
  }
}
