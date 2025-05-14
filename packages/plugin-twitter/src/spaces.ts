import {
  ChannelType,
  type IAgentRuntime,
  ModelType,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { ClientBase } from './base';
import {
  type Client,
  IdleMonitorPlugin,
  Space,
  type SpaceConfig,
  SpaceParticipant,
  type SpeakerRequest,
} from './client/index';
import { SttTtsPlugin } from './sttTtsSpaces';
import { generateTopicsIfEmpty, isAgentInSpace, speakFiller } from './utils';

/**
 * Interface representing options for deciding on creating a Twitter Space.
 * @typedef {Object} TwitterSpaceDecisionOptions
 * @property {number} [maxSpeakers] - Maximum number of speakers allowed in the Twitter Space.
 * @property {number} [typicalDurationMinutes] - Typical duration of the Twitter Space in minutes.
 * @property {number} [idleKickTimeoutMs] - Timeout in milliseconds for kicking idle users from the Twitter Space.
 * @property {number} [minIntervalBetweenSpacesMinutes] - Minimum interval between creating new Twitter Spaces in minutes.
 * @property {boolean} [enableIdleMonitor] - Flag to enable or disable idle user monitoring in the Twitter Space.
 * @property {boolean} enableSpaceHosting - Flag to enable or disable space hosting in the Twitter Space.
 * @property {boolean} [enableRecording] - Flag to enable or disable recording of the Twitter Space.
 * @property {number} [speakerMaxDurationMs] - Maximum duration in milliseconds for each speaker in the Twitter Space.
 */
export interface TwitterSpaceDecisionOptions {
  maxSpeakers?: number;
  typicalDurationMinutes?: number;
  idleKickTimeoutMs?: number;
  minIntervalBetweenSpacesMinutes?: number;
  enableIdleMonitor?: boolean;
  enableSpaceHosting: boolean;
  enableRecording?: boolean;
  speakerMaxDurationMs?: number;
}

/**
 * Represents the state of the current speaker in a session.
 * @typedef { Object } CurrentSpeakerState
 * @property { string } userId - The unique identifier of the user who is the current speaker.
 * @property { string } sessionUUID - The unique identifier of the session the speaker is in.
 * @property { string } username - The username of the current speaker.
 * @property { number } startTime - The timestamp when the current speaker started speaking.
 */
interface CurrentSpeakerState {
  userId: string;
  sessionUUID: string;
  username: string;
  startTime: number;
}

/**
 * Enum representing space activity options.
 *
 * @enum {string}
 * @readonly
 * @property {string} HOSTING - Indicates that the space is being used for hosting an event.
 * @property {string} PARTICIPATING - Indicates that the space is being used for participating in an event.
 * @property {string} IDLE - Indicates that the space is not currently being used.
 */
export enum SpaceActivity {
  HOSTING = 'hosting',
  PARTICIPATING = 'participating',
  IDLE = 'idle',
}

/**
 * An enum representing the activity role of a participant.
 * @enum {string}
 * @readonly
 * @property {string} LISTENER - Represents a participant who is a listener.
 * @property {string} SPEAKER - Represents a participant who is a speaker.
 * @property {string} PENDING - Represents a participant whose activity is pending.
 */
export enum ParticipantActivity {
  LISTENER = 'listener',
  SPEAKER = 'speaker',
  PENDING = 'pending',
}

/**
 * Main class: manage a Twitter Space with N speakers max, speaker queue, filler messages, etc.
 */
/**
 * Represents a client for interacting with Twitter Spaces.
 * * @class
 * @property { IAgentRuntime } runtime - The agent runtime for the client.
 * @property { ClientBase } client - The base client for making requests.
 * @property { Client } twitterClient - The Twitter client for interacting with Twitter API.
 * @property {Space | undefined} currentSpace - The current Twitter Space the client is connected to (if any).
 * @property {string | undefined} spaceId - The ID of the Twitter Space the client is connected to (if any).
 * @property {number | undefined} startedAt - The timestamp when the client was started.
 * @property {NodeJS.Timeout | undefined} checkInterval - The interval for checking the status of the Twitter Space.
 * @property {number | undefined} lastSpaceEndedAt - The timestamp of when the last Twitter Space ended.
 */
export class TwitterSpaceClient {
  private runtime: IAgentRuntime;
  private client: ClientBase;
  private twitterClient: Client;
  private currentSpace?: Space;
  private spaceId?: string;
  private startedAt?: number;
  private checkInterval?: NodeJS.Timeout;
  private lastSpaceEndedAt?: number;
  private sttTtsPlugin?: SttTtsPlugin;
  public spaceStatus: SpaceActivity = SpaceActivity.IDLE;
  private spaceParticipant: SpaceParticipant | null = null;
  public participantStatus: ParticipantActivity = ParticipantActivity.LISTENER;

  /**
   * We now store an array of active speakers, not just 1
   */
  private activeSpeakers: CurrentSpeakerState[] = [];
  private speakerQueue: SpeakerRequest[] = [];

  private decisionOptions: TwitterSpaceDecisionOptions;

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.twitterClient = client.twitterClient;
    this.runtime = runtime;

    this.sttTtsPlugin = new SttTtsPlugin();

    // TODO: Spaces should be added to and removed from cache probably, and it should be possible to join or leave a space from an action, etc
    const charSpaces = runtime.character.settings?.twitter?.spaces || {};
    this.decisionOptions = {
      maxSpeakers: charSpaces.maxSpeakers ?? 1,
      typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 30,
      idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 5 * 60_000,
      minIntervalBetweenSpacesMinutes: charSpaces.minIntervalBetweenSpacesMinutes ?? 60,
      enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
      enableRecording: charSpaces.enableRecording !== false,
      enableSpaceHosting: charSpaces.enableSpaceHosting || false,
      speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 4 * 60_000,
    };
  }

  /**
   * Periodic check to launch or manage space
   */
  public async startPeriodicSpaceCheck() {
    logger.log('[Space] Starting periodic check routine...');

    const interval = 20_000;

    const routine = async () => {
      try {
        if (this.spaceStatus === SpaceActivity.IDLE) {
          if (this.decisionOptions.enableSpaceHosting) {
            // Space not running => check if we should launch
            const launch = await this.shouldLaunchSpace();
            if (launch) {
              const config = await this.generateSpaceConfig();
              await this.startSpace(config);
            }
          }
        } else {
          if (this.spaceStatus === SpaceActivity.HOSTING) {
            await this.manageCurrentSpace();
          } else if (this.spaceStatus === SpaceActivity.PARTICIPATING) {
            await this.manageParticipant();
          }
        }
        this.checkInterval = setTimeout(routine, interval) as any;
      } catch (error) {
        logger.error('[Space] Error in routine =>', error);
        // In case of error, still schedule next iteration
        this.checkInterval = setTimeout(routine, interval) as any;
      }
    };

    routine();
  }

  stopPeriodicCheck() {
    if (this.checkInterval) {
      clearTimeout(this.checkInterval);
      this.checkInterval = undefined;
    }
  }

  private async shouldLaunchSpace(): Promise<boolean> {
    // Interval
    const now = Date.now();
    if (this.lastSpaceEndedAt) {
      const minIntervalMs = (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) * 60_000;
      if (now - this.lastSpaceEndedAt < minIntervalMs) {
        logger.log('[Space] Too soon since last space => skip');
        return false;
      }
    }

    logger.log('[Space] Deciding to launch a new Space...');
    return true;
  }

  private async generateSpaceConfig(): Promise<SpaceConfig> {
    let chosenTopic = 'Random Tech Chat';
    let topics = this.runtime.character.topics || [];
    if (!topics.length) {
      const newTopics = await generateTopicsIfEmpty(this.client.runtime);
      topics = newTopics;
    }

    chosenTopic = topics[Math.floor(Math.random() * topics.length)];

    return {
      record: this.decisionOptions.enableRecording,
      mode: 'INTERACTIVE',
      title: chosenTopic,
      description: `Discussion about ${chosenTopic}`,
      languages: ['en'],
    };
  }

  public async startSpace(config: SpaceConfig) {
    logger.log('[Space] Starting a new Twitter Space...');

    try {
      this.currentSpace = new Space(this.twitterClient);
      this.spaceStatus = SpaceActivity.IDLE;
      this.spaceId = undefined;
      this.startedAt = Date.now();

      // Reset states
      this.activeSpeakers = [];
      this.speakerQueue = [];

      const broadcastInfo = await this.currentSpace.initialize(config);
      this.spaceId = broadcastInfo.room_id;

      // Create standardized world and room IDs for the space
      const userId = this.client.profile.id;
      const worldId = createUniqueUuid(this.runtime, userId);
      const spaceRoomId = createUniqueUuid(this.runtime, `${userId}-space-${this.spaceId}`);

      // Ensure world exists first
      await this.runtime.ensureWorldExists({
        id: worldId,
        worldName: config.title || 'Twitter Space',
        name: `${this.client.profile.username}'s Twitter`,
        agentId: this.runtime.agentId,
        serverId: userId,
        source: 'twitter',
        metadata: {
          ownership: { ownerId: userId },
          twitter: {
            username: this.client.profile.username,
            id: userId,
          },
          spaceInfo: {
            title: config.title,
            description: config.description,
            startedAt: Date.now(),
            mode: config.mode,
            languages: config.languages,
            isRecording: config.record,
          },
        },
      });

      if (
        this.runtime.getModel(ModelType.TEXT_TO_SPEECH) &&
        this.runtime.getModel(ModelType.TRANSCRIPTION)
      ) {
        logger.log('[Space] Using SttTtsPlugin');
        this.currentSpace.use(this.sttTtsPlugin as any, {
          runtime: this.runtime,
          spaceId: this.spaceId,
        });
      }

      if (this.decisionOptions.enableIdleMonitor) {
        logger.log('[Space] Using IdleMonitorPlugin');
        this.currentSpace.use(
          new IdleMonitorPlugin(this.decisionOptions.idleKickTimeoutMs ?? 60_000, 10_000)
        );
      }
      this.spaceStatus = SpaceActivity.HOSTING;

      // Create tweet announcing the space
      const spaceUrl = broadcastInfo.share_url.replace('broadcasts', 'spaces');
      await this.twitterClient.sendTweet(spaceUrl);

      logger.log(`[Space] Space started => ${spaceUrl}`);

      // Greet
      await speakFiller(this.client.runtime, this.sttTtsPlugin, 'WELCOME');

      // Events
      this.currentSpace.on('occupancyUpdate', (update) => {
        logger.log(`[Space] Occupancy => ${update.occupancy} participant(s).`);
      });

      this.currentSpace.on('speakerRequest', async (req: SpeakerRequest) => {
        logger.log(`[Space] Speaker request from @${req.username} (${req.userId}).`);
        await this.handleSpeakerRequest(req);
      });

      this.currentSpace.on('idleTimeout', async (info) => {
        logger.log(`[Space] idleTimeout => no audio for ${info.idleMs} ms.`);
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'IDLE_ENDING');
        await this.stopSpace();
      });

      process.on('SIGINT', async () => {
        logger.log('[Space] SIGINT => stopping space');
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'CLOSING');
        await this.stopSpace();
        process.exit(0);
      });
    } catch (error) {
      logger.error('[Space] Error launching Space =>', error);
      this.spaceStatus = SpaceActivity.IDLE;
      throw error;
    }
  }

  /**
   * Periodic management: check durations, remove extras, maybe accept new from queue
   */
  private async manageCurrentSpace() {
    if (!this.spaceId || !this.currentSpace) return;
    try {
      const audioSpace = await this.twitterClient.getAudioSpaceById(this.spaceId);
      const { participants } = audioSpace;
      const numSpeakers = participants.speakers?.length || 0;
      const totalListeners = participants.listeners?.length || 0;

      // 1) Remove any speaker who exceeded speakerMaxDurationMs
      const maxDur = this.decisionOptions.speakerMaxDurationMs ?? 240_000;
      const now = Date.now();

      for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
        const speaker = this.activeSpeakers[i];
        const elapsed = now - speaker.startTime;
        if (elapsed > maxDur) {
          logger.log(`[Space] Speaker @${speaker.username} exceeded max duration => removing`);
          await this.removeSpeaker(speaker.userId);
          this.activeSpeakers.splice(i, 1);

          // Possibly speak a short "SPEAKER_LEFT" filler
          await speakFiller(this.client.runtime, this.sttTtsPlugin, 'SPEAKER_LEFT');
        }
      }

      // 2) If we have capacity for new speakers from the queue, accept them
      await this.acceptSpeakersFromQueueIfNeeded();

      // 3) If somehow more than maxSpeakers are active, remove the extras
      if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
        logger.log('[Space] More than maxSpeakers => removing extras...');
        await this.kickExtraSpeakers(participants.speakers);
      }

      // 4) Possibly stop the space if empty or time exceeded
      const elapsedMinutes = (now - (this.startedAt || 0)) / 60000;
      if (
        elapsedMinutes > (this.decisionOptions.typicalDurationMinutes ?? 30) ||
        (numSpeakers === 0 && totalListeners === 0 && elapsedMinutes > 5)
      ) {
        logger.log('[Space] Condition met => stopping the Space...');
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'CLOSING', 4000);
        await this.stopSpace();
      }
    } catch (error) {
      logger.error('[Space] Error in manageCurrentSpace =>', error);
    }
  }

  /**
   * If we have available slots, accept new speakers from the queue
   */
  private async acceptSpeakersFromQueueIfNeeded() {
    // while queue not empty and activeSpeakers < maxSpeakers, accept next
    const ms = this.decisionOptions.maxSpeakers ?? 1;
    while (this.speakerQueue.length > 0 && this.activeSpeakers.length < ms) {
      const nextReq = this.speakerQueue.shift();
      if (nextReq) {
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'PRE_ACCEPT');
        await this.acceptSpeaker(nextReq);
      }
    }
  }

  private async handleSpeakerRequest(req: SpeakerRequest) {
    if (!this.spaceId || !this.currentSpace) return;

    const audioSpace = await this.twitterClient.getAudioSpaceById(this.spaceId);
    const janusSpeakers = audioSpace?.participants?.speakers || [];

    // If we haven't reached maxSpeakers, accept immediately
    if (janusSpeakers.length < (this.decisionOptions.maxSpeakers ?? 1)) {
      logger.log(`[Space] Accepting speaker @${req.username} now`);
      await speakFiller(this.client.runtime, this.sttTtsPlugin, 'PRE_ACCEPT');
      await this.acceptSpeaker(req);
    } else {
      logger.log(`[Space] Adding speaker @${req.username} to the queue`);
      this.speakerQueue.push(req);
    }
  }

  private async acceptSpeaker(req: SpeakerRequest) {
    if (!this.currentSpace) return;
    try {
      await this.currentSpace.approveSpeaker(req.userId, req.sessionUUID);
      this.activeSpeakers.push({
        userId: req.userId,
        sessionUUID: req.sessionUUID,
        username: req.username,
        startTime: Date.now(),
      });
      logger.log(`[Space] Speaker @${req.username} is now live`);
    } catch (err) {
      logger.error(`[Space] Error approving speaker @${req.username}:`, err);
    }
  }

  private async removeSpeaker(userId: string) {
    if (!this.currentSpace) return;
    try {
      await this.currentSpace.removeSpeaker(userId);
      logger.log(`[Space] Removed speaker userId=${userId}`);
    } catch (error) {
      logger.error(`[Space] Error removing speaker userId=${userId} =>`, error);
    }
  }

  /**
   * If more than maxSpeakers are found, remove extras
   * Also update activeSpeakers array
   */
  private async kickExtraSpeakers(speakers: any[]) {
    if (!this.currentSpace) return;
    const ms = this.decisionOptions.maxSpeakers ?? 1;

    // sort by who joined first if needed, or just slice
    const extras = speakers.slice(ms);
    for (const sp of extras) {
      logger.log(`[Space] Removing extra speaker => userId=${sp.user_id}`);
      await this.removeSpeaker(sp.user_id);

      // remove from activeSpeakers array
      const idx = this.activeSpeakers.findIndex((s) => s.userId === sp.user_id);
      if (idx !== -1) {
        this.activeSpeakers.splice(idx, 1);
      }
    }
  }

  public async stopSpace() {
    if (!this.currentSpace || this.spaceStatus !== SpaceActivity.HOSTING) return;
    try {
      logger.log('[Space] Stopping the current Space...');
      await this.currentSpace.stop();
    } catch (err) {
      logger.error('[Space] Error stopping Space =>', err);
    } finally {
      this.spaceStatus = SpaceActivity.IDLE;
      this.spaceId = undefined;
      this.currentSpace = undefined;
      this.startedAt = undefined;
      this.lastSpaceEndedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
    }
  }

  async startParticipant(spaceId: string) {
    if (this.spaceStatus !== SpaceActivity.IDLE) {
      logger.warn('currently hosting/participating a space');
      return null;
    }

    this.spaceParticipant = new SpaceParticipant(this.client.twitterClient, {
      spaceId,
      debug: false,
    });

    if (this.spaceParticipant) {
      try {
        await this.spaceParticipant.joinAsListener();

        this.spaceId = spaceId;
        this.spaceStatus = SpaceActivity.PARTICIPATING;

        return spaceId;
      } catch (error) {
        logger.error(`failed to join space ${error}`);
        return null;
      }
    }
  }

  async manageParticipant() {
    if (!this.spaceParticipant || !this.spaceId) {
      this.stopParticipant();
      return;
    }

    const isParticipant = await isAgentInSpace(this.client, this.spaceId);

    if (!isParticipant) {
      this.stopParticipant();
      return;
    }

    // Check if we should request to speak
    if (this.participantStatus === ParticipantActivity.LISTENER) {
      logger.log('[SpaceParticipant] Checking if we should request to speak...');

      this.participantStatus = ParticipantActivity.PENDING;

      const { sessionUUID } = await this.spaceParticipant.requestSpeaker();

      const handleSpeakerRemove = async (evt: { sessionUUID: string }) => {
        if (evt.sessionUUID === sessionUUID) {
          logger.debug('[SpaceParticipant] Speaker removed:', evt);
          try {
            await this.spaceParticipant.removeFromSpeaker();
          } catch (err) {
            console.error('[SpaceParticipant] Failed to become speaker:', err);
          }
          this.participantStatus = ParticipantActivity.LISTENER;
          this.spaceParticipant?.off('newSpeakerRemoved', handleSpeakerRemove);
        }
      };

      // Attach listener for speaker removal
      this.spaceParticipant.on('newSpeakerRemoved', handleSpeakerRemove);

      this.waitForApproval(this.spaceParticipant, sessionUUID, 15000)
        .then(() => {
          this.participantStatus = ParticipantActivity.SPEAKER;
          this.spaceParticipant.use(this.sttTtsPlugin as any, {
            runtime: this.runtime,
            spaceId: this.spaceId,
          });
        })
        .catch(async (err) => {
          console.error('[SpaceParticipant] Approval error or timeout =>', err);

          this.participantStatus = ParticipantActivity.LISTENER;

          try {
            await this.spaceParticipant.cancelSpeakerRequest();
            logger.debug('[SpaceParticipant] Speaker request canceled after timeout or error.');
          } catch (cancelErr) {
            console.error('[SpaceParticipant] Could not cancel the request =>', cancelErr);
          }
        });
    }
  }

  public async stopParticipant() {
    if (!this.spaceParticipant || this.spaceStatus !== SpaceActivity.PARTICIPATING) return;
    try {
      logger.log('[SpaceParticipant] Stopping the current space participant...');
      await this.spaceParticipant.leaveSpace();
    } catch (err) {
      logger.error('[SpaceParticipant] Error stopping space participant =>', err);
    } finally {
      this.spaceStatus = SpaceActivity.IDLE;
      this.participantStatus = ParticipantActivity.LISTENER;
      this.spaceId = undefined;
      this.spaceParticipant = undefined;
    }
  }

  /**
   * waitForApproval waits until "newSpeakerAccepted" matches our sessionUUID,
   * then calls becomeSpeaker() or rejects after a given timeout.
   */
  async waitForApproval(
    participant: SpaceParticipant,
    sessionUUID: string,
    timeoutMs = 10000
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const handler = async (evt: { sessionUUID: string }) => {
        if (evt.sessionUUID === sessionUUID) {
          resolved = true;
          participant.off('newSpeakerAccepted', handler);
          try {
            await participant.becomeSpeaker();
            logger.debug('[SpaceParticipant] Successfully became speaker!');
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      };

      // Listen to "newSpeakerAccepted" from participant
      participant.on('newSpeakerAccepted', handler);

      // Timeout to reject if not approved in time
      setTimeout(() => {
        if (!resolved) {
          participant.off('newSpeakerAccepted', handler);
          reject(
            new Error(
              `[SpaceParticipant] Timed out waiting for speaker approval after ${timeoutMs}ms.`
            )
          );
        }
      }, timeoutMs);
    });
  }
}
