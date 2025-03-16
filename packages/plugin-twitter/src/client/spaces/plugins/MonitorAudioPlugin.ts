import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Logger } from '../logger';
import type { AudioDataWithUser, Plugin } from '../types';

/**
 * MonitorAudioPlugin
 * ------------------
 * A simple plugin that spawns an `ffplay` process to play raw PCM audio in real time.
 * It reads frames from `onAudioData()` and writes them to ffplay via stdin.
 *
 * Usage:
 *   const plugin = new MonitorAudioPlugin(48000, /* debug= *\/ true);
 *   space.use(plugin);
 */
/**
 * MonitorAudioPlugin class that implements Plugin interface.
 *
 * @param {number} sampleRate The expected PCM sample rate (e.g. 16000 or 48000).
 * @param {boolean} debug If true, enables debug logging via Logger.
 *
 * @method onAudioData Called whenever PCM frames arrive (from a speaker).
 * @param {AudioDataWithUser} data The audio data received.
 *
 * @method cleanup Cleanup function called when the plugin is removed or when the space/participant stops.
 */
export class MonitorAudioPlugin implements Plugin {
  private ffplay?: ChildProcessWithoutNullStreams;
  private logger: Logger;

  /**
   * @param sampleRate  The expected PCM sample rate (e.g. 16000 or 48000).
   * @param debug       If true, enables debug logging via Logger.
   */
  constructor(
    private readonly sampleRate = 48000,
    debug = false
  ) {
    this.logger = new Logger(debug);

    // Spawn ffplay to read raw PCM (s16le) on stdin
    this.ffplay = spawn('ffplay', [
      '-f',
      's16le',
      '-ar',
      this.sampleRate.toString(),
      '-ac',
      '1', // mono
      '-nodisp',
      '-loglevel',
      'quiet',
      '-i',
      'pipe:0',
    ]);

    this.ffplay.on('error', (err) => {
      this.logger.error('[MonitorAudioPlugin] ffplay error =>', err);
    });

    this.ffplay.on('close', (code) => {
      this.logger.info('[MonitorAudioPlugin] ffplay closed => code=', code);
      this.ffplay = undefined;
    });

    this.logger.info(
      `[MonitorAudioPlugin] Started ffplay for real-time monitoring (sampleRate=${this.sampleRate})`
    );
  }

  /**
   * Called whenever PCM frames arrive (from a speaker).
   * Writes frames to ffplay's stdin to play them in real time.
   */
  onAudioData(data: AudioDataWithUser): void {
    // Log debug info
    this.logger.debug(
      `[MonitorAudioPlugin] onAudioData => userId=${data.userId}, samples=${data.samples.length}, sampleRate=${data.sampleRate}`
    );

    if (!this.ffplay?.stdin.writable) {
      return;
    }

    // In this plugin, we assume data.sampleRate matches our expected sampleRate.
    // Convert the Int16Array to a Buffer, then write to ffplay stdin.
    const pcmBuffer = Buffer.from(data.samples.buffer);
    this.ffplay.stdin.write(pcmBuffer);
  }

  /**
   * Cleanup is called when the plugin is removed or when the space/participant stops.
   * Ends the ffplay process and closes its stdin pipe.
   */
  cleanup(): void {
    this.logger.info('[MonitorAudioPlugin] Cleanup => stopping ffplay');
    if (this.ffplay) {
      this.ffplay.stdin.end();
      this.ffplay.kill();
      this.ffplay = undefined;
    }
  }
}
