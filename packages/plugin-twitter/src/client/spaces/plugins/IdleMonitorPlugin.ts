import type { Space } from '../core/Space';
import { Logger } from '../logger';
import type { AudioDataWithUser, Plugin } from '../types';

/**
 * IdleMonitorPlugin
 * -----------------
 * Monitors silence in both remote speaker audio and local (pushed) audio.
 * If no audio is detected for a specified duration, it emits an 'idleTimeout' event on the space.
 */
/**
 * Class representing an Idle Monitor Plugin.
 * * @implements { Plugin }
 */
export class IdleMonitorPlugin implements Plugin {
  private space?: Space;
  private logger?: Logger;

  private lastSpeakerAudioMs = Date.now();
  private lastLocalAudioMs = Date.now();
  private checkInterval?: NodeJS.Timeout;

  /**
   * @param idleTimeoutMs The duration (in ms) of total silence before triggering idle. (Default: 60s)
   * @param checkEveryMs  How frequently (in ms) to check for silence. (Default: 10s)
   */
  constructor(
    private idleTimeoutMs = 60_000,
    private checkEveryMs = 10_000
  ) {}

  /**
   * Called immediately after .use(plugin).
   * Allows for minimal setup, including obtaining a debug logger if desired.
   */
  onAttach(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    this.space = params.space;
    const debug = params.pluginConfig?.debug ?? false;
    this.logger = new Logger(debug);

    this.logger.info('[IdleMonitorPlugin] onAttach => plugin attached');
  }

  /**
   * Called once the space has fully initialized (basic mode).
   * We set up idle checks and override pushAudio to detect local audio activity.
   */
  init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    this.space = params.space;
    this.logger?.info('[IdleMonitorPlugin] init => setting up idle checks');

    // Update lastSpeakerAudioMs on incoming speaker audio
    // (Here we're hooking into an event triggered by Space for each speaker's PCM data.)
    this.space.on('audioDataFromSpeaker', (_data: AudioDataWithUser) => {
      this.lastSpeakerAudioMs = Date.now();
    });

    // Patch space.pushAudio to track local audio
    const originalPushAudio = this.space.pushAudio.bind(this.space);
    this.space.pushAudio = (samples, sampleRate) => {
      this.lastLocalAudioMs = Date.now();
      originalPushAudio(samples, sampleRate);
    };

    // Periodically check for silence
    this.checkInterval = setInterval(() => this.checkIdle(), this.checkEveryMs) as any;
  }

  /**
   * Checks if we've exceeded idleTimeoutMs with no audio activity.
   * If so, emits an 'idleTimeout' event on the space with { idleMs } info.
   */
  private checkIdle() {
    const now = Date.now();
    const lastAudio = Math.max(this.lastSpeakerAudioMs, this.lastLocalAudioMs);
    const idleMs = now - lastAudio;

    if (idleMs >= this.idleTimeoutMs) {
      this.logger?.warn(`[IdleMonitorPlugin] idleTimeout => no audio for ${idleMs}ms`);
      this.space?.emit('idleTimeout', { idleMs });
    }
  }

  /**
   * Returns how many milliseconds have passed since any audio was detected (local or speaker).
   */
  public getIdleTimeMs(): number {
    const now = Date.now();
    const lastAudio = Math.max(this.lastSpeakerAudioMs, this.lastLocalAudioMs);
    return now - lastAudio;
  }

  /**
   * Cleans up resources (interval) when the plugin is removed or space stops.
   */
  cleanup(): void {
    this.logger?.info('[IdleMonitorPlugin] cleanup => stopping idle checks');
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
  }
}
