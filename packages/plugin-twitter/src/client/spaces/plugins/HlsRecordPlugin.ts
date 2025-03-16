import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Space } from '../core/Space';
import { Logger } from '../logger';
import type { OccupancyUpdate, Plugin } from '../types';

/**
 * HlsRecordPlugin
 * ---------------
 * Records the final Twitter Spaces HLS mix to a local .ts file using ffmpeg.
 *
 * Workflow:
 *  - Wait for occupancy > 0 (i.e., at least one listener).
 *  - Attempt to retrieve the HLS URL from Twitter (via client).
 *  - If valid (HTTP 200), spawn ffmpeg to record the stream.
 *  - If HLS not ready yet (HTTP 404), wait for next occupancy event.
 *
 * Lifecycle:
 *  - onAttach(...) => minimal references, logger setup
 *  - init(...) => fully runs once the Space is created (broadcastInfo ready)
 *  - cleanup() => stop ffmpeg if running
 */
/**
 * HlsRecordPlugin class for recording HLS stream from Twitter Space.
 *
 * @param {string} [outputPath] - Optional output path for recording.
 *
 * @property {Logger} [logger] - Logger instance for logging.
 * @property {ChildProcessWithoutNullStreams} [recordingProcess] - Child process for recording.
 * @property {boolean} isRecording - Flag indicating if recording is in progress.
 * @property {string} [outputPath] - Output path for recording.
 * @property {string} [mediaKey] - Media key for the broadcast.
 * @property {Space} [space] - Twitter Space instance where recording is happening.
 *
 * @method constructor - HlsRecordPlugin constructor.
 * @method onAttach - Method called after attaching the plugin to store references and create a Logger.
 * @method init - Method called after Space has fully initialized to prepare for recording.
 * @method handleOccupancyUpdate - Private method to handle occupancy updates and start recording if necessary.
 * @method waitForHlsReady - Private method to check if HLS URL is ready for recording.
 * @method startRecording - Private method to spawn ffmpeg for recording HLS stream.
 * @method cleanup - Method called when the plugin is being cleaned up, to stop the recording process.
 */

export class HlsRecordPlugin implements Plugin {
  private logger?: Logger;
  private recordingProcess?: ChildProcessWithoutNullStreams;
  private isRecording = false;

  private outputPath?: string;
  private mediaKey?: string;
  private space?: Space;

  /**
   * You can optionally provide an outputPath in the constructor.
   * Alternatively, it can be set via pluginConfig in onAttach/init.
   */
  constructor(outputPath?: string) {
    this.outputPath = outputPath;
  }

  /**
   * Called immediately after .use(plugin). We store references here
   * (e.g., the space) and create a Logger based on pluginConfig.debug.
   */
  onAttach(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    this.space = params.space;

    const debug = params.pluginConfig?.debug ?? false;
    this.logger = new Logger(debug);

    this.logger.info('[HlsRecordPlugin] onAttach => plugin attached');

    // If outputPath was not passed in constructor, check pluginConfig
    if (params.pluginConfig?.outputPath) {
      this.outputPath = params.pluginConfig.outputPath;
    }
  }

  /**
   * Called once the Space has fully initialized (broadcastInfo is ready).
   * We retrieve the media_key from the broadcast, subscribe to occupancy,
   * and prepare for recording if occupancy > 0.
   */
  async init(params: { space: Space; pluginConfig?: Record<string, any> }) {
    // Merge plugin config again (in case it was not set in onAttach).
    if (params.pluginConfig?.outputPath) {
      this.outputPath = params.pluginConfig.outputPath;
    }

    // Use the same logger from onAttach
    const broadcastInfo = (this.space as any)?.broadcastInfo;
    if (!broadcastInfo || !broadcastInfo.broadcast?.media_key) {
      this.logger?.warn('[HlsRecordPlugin] No media_key found in broadcastInfo');
      return;
    }
    this.mediaKey = broadcastInfo.broadcast.media_key;

    // If no custom output path was provided, use a default
    const roomId = broadcastInfo.room_id || 'unknown_room';
    if (!this.outputPath) {
      this.outputPath = `/tmp/record_${roomId}.ts`;
    }

    this.logger?.info(
      `[HlsRecordPlugin] init => ready to record. Output path="${this.outputPath}"`
    );

    // Listen for occupancy updates
    this.space?.on('occupancyUpdate', (update: OccupancyUpdate) => {
      this.handleOccupancyUpdate(update).catch((err) => {
        this.logger?.error('[HlsRecordPlugin] handleOccupancyUpdate =>', err);
      });
    });
  }

  /**
   * If occupancy > 0 and we're not recording yet, attempt to fetch the HLS URL
   * from Twitter. If it's ready, spawn ffmpeg to record.
   */
  private async handleOccupancyUpdate(update: OccupancyUpdate) {
    if (!this.space || !this.mediaKey) return;
    if (this.isRecording) return;
    if (update.occupancy <= 0) {
      this.logger?.debug('[HlsRecordPlugin] occupancy=0 => ignoring');
      return;
    }

    this.logger?.debug(
      `[HlsRecordPlugin] occupancy=${update.occupancy} => trying to fetch HLS URL...`
    );

    const client = (this.space as any).client;
    if (!client) {
      this.logger?.warn('[HlsRecordPlugin] No client found on space');
      return;
    }

    try {
      const status = await client.getAudioSpaceStreamStatus(this.mediaKey);
      if (!status?.source?.location) {
        this.logger?.debug('[HlsRecordPlugin] occupancy>0 but no HLS URL => wait next update');
        return;
      }

      const hlsUrl = status.source.location;
      const isReady = await this.waitForHlsReady(hlsUrl, 1);
      if (!isReady) {
        this.logger?.debug('[HlsRecordPlugin] HLS URL 404 => waiting next occupancy update...');
        return;
      }
      await this.startRecording(hlsUrl);
    } catch (err) {
      this.logger?.error('[HlsRecordPlugin] handleOccupancyUpdate =>', err);
    }
  }

  /**
   * HEAD request to see if the HLS URL is returning 200 OK.
   * maxRetries=1 => only try once here; rely on occupancy re-calls otherwise.
   */
  private async waitForHlsReady(hlsUrl: string, maxRetries: number): Promise<boolean> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const resp = await fetch(hlsUrl, { method: 'HEAD' });
        if (resp.ok) {
          this.logger?.debug(`[HlsRecordPlugin] HLS is ready (attempt #${attempt + 1})`);
          return true;
        }
        this.logger?.debug(`[HlsRecordPlugin] HLS status=${resp.status}, retrying...`);
      } catch (error) {
        this.logger?.debug('[HlsRecordPlugin] HLS fetch error =>', (error as Error).message);
      }
      attempt++;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * Spawns ffmpeg to record the HLS stream at the given URL.
   */
  private async startRecording(hlsUrl: string): Promise<void> {
    if (this.isRecording) {
      this.logger?.debug('[HlsRecordPlugin] Already recording, skipping...');
      return;
    }
    this.isRecording = true;

    if (!this.outputPath) {
      this.logger?.warn('[HlsRecordPlugin] No output path set, using /tmp/space_record.ts');
      this.outputPath = '/tmp/space_record';
    }

    this.logger?.info('[HlsRecordPlugin] Starting HLS recording =>', hlsUrl);

    this.recordingProcess = spawn('ffmpeg', ['-y', '-i', hlsUrl, '-c', 'copy', this.outputPath]);

    // Capture stderr for errors or debug info
    this.recordingProcess.stderr.on('data', (chunk) => {
      const msg = chunk.toString();
      if (msg.toLowerCase().includes('error')) {
        this.logger?.error('[HlsRecordPlugin][ffmpeg error] =>', msg.trim());
      } else {
        this.logger?.debug('[HlsRecordPlugin][ffmpeg]', msg.trim());
      }
    });

    this.recordingProcess.on('close', (code) => {
      this.isRecording = false;
      this.logger?.info('[HlsRecordPlugin] Recording process closed => code=', code);
    });

    this.recordingProcess.on('error', (err) => {
      this.logger?.error('[HlsRecordPlugin] Recording process failed =>', err);
    });
  }

  /**
   * Called when the plugin is cleaned up (e.g. space.stop()).
   * Kills ffmpeg if still running.
   */
  cleanup(): void {
    if (this.isRecording && this.recordingProcess) {
      this.logger?.info('[HlsRecordPlugin] Stopping HLS recording...');
      this.recordingProcess.kill();
      this.recordingProcess = undefined;
      this.isRecording = false;
    }
  }
}
