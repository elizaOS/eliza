// src/core/JanusAudio.ts

import { EventEmitter } from 'node:events';
import wrtc from '@roamhq/wrtc';
const { nonstandard } = wrtc;
const { RTCAudioSource, RTCAudioSink } = nonstandard;
import type { Logger } from '../logger';

/**
 * Configuration options for the JanusAudioSource.
 */
/**
 * Optional logger instance for debug/info/warn logs.
 */
interface AudioSourceOptions {
  /**
   * Optional logger instance for debug/info/warn logs.
   */
  logger?: Logger;
}

/**
 * Configuration options for the JanusAudioSink.
 */
interface AudioSinkOptions {
  /**
   * Optional logger instance for debug/info/warn logs.
   */
  logger?: Logger;
}

/**
 * JanusAudioSource wraps a RTCAudioSource, allowing you to push
 * raw PCM frames (Int16Array) into the WebRTC pipeline.
 */
export class JanusAudioSource extends EventEmitter {
  private source: any;
  private readonly track: MediaStreamTrack;
  private logger?: Logger;

  constructor(options?: AudioSourceOptions) {
    super();
    this.logger = options?.logger;
    this.source = new RTCAudioSource();
    this.track = this.source.createTrack();
  }

  /**
   * Returns the MediaStreamTrack associated with this audio source.
   */
  public getTrack(): MediaStreamTrack {
    return this.track;
  }

  /**
   * Pushes PCM data into the RTCAudioSource. Typically 16-bit, single- or multi-channel frames.
   * @param samples - The Int16Array audio samples.
   * @param sampleRate - The sampling rate (e.g., 48000).
   * @param channels - Number of channels (e.g., 1 for mono).
   */
  public pushPcmData(samples: Int16Array, sampleRate: number, channels = 1): void {
    if (this.logger?.isDebugEnabled()) {
      this.logger?.debug(
        `[JanusAudioSource] pushPcmData => sampleRate=${sampleRate}, channels=${channels}, frames=${samples.length}`
      );
    }

    // Feed data into the RTCAudioSource
    this.source.onData({
      samples,
      sampleRate,
      bitsPerSample: 16,
      channelCount: channels,
      numberOfFrames: samples.length / channels,
    });
  }
}

/**
 * JanusAudioSink wraps a RTCAudioSink, providing an event emitter
 * that forwards raw PCM frames (Int16Array) to listeners.
 */
export class JanusAudioSink extends EventEmitter {
  private sink: any;
  private active = true;
  private logger?: Logger;

  constructor(track: MediaStreamTrack, options?: AudioSinkOptions) {
    super();
    this.logger = options?.logger;

    if (track.kind !== 'audio') {
      throw new Error('[JanusAudioSink] Provided track is not an audio track');
    }

    // Create RTCAudioSink to listen for PCM frames
    this.sink = new RTCAudioSink(track);

    // Register callback for PCM frames
    this.sink.ondata = (frame: {
      samples: Int16Array;
      sampleRate: number;
      bitsPerSample: number;
      channelCount: number;
    }) => {
      if (!this.active) return;

      if (this.logger?.isDebugEnabled()) {
        this.logger?.debug(
          `[JanusAudioSink] ondata => sampleRate=${frame.sampleRate}, bitsPerSample=${frame.bitsPerSample}, channelCount=${frame.channelCount}, frames=${frame.samples.length}`
        );
      }

      // Emit 'audioData' event with the raw PCM frame
      this.emit('audioData', frame);
    };
  }

  /**
   * Stops receiving audio data. Once called, no further 'audioData' events will be emitted.
   */
  public stop(): void {
    this.active = false;
    if (this.logger?.isDebugEnabled()) {
      this.logger?.debug('[JanusAudioSink] stop called => stopping the sink');
    }
    this.sink?.stop();
  }
}
