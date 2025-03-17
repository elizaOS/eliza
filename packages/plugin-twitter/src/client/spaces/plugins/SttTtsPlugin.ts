// src/plugins/SttTtsPlugin.ts

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JanusClient } from '../core/JanusClient';
import type { Space } from '../core/Space';
import type { SpaceParticipant } from '../core/SpaceParticipant';
import { Logger } from '../logger';
import type { AudioDataWithUser, Plugin } from '../types';
import { logger } from '@elizaos/core';

/**
 * Interface for configuring a plugin
 * @typedef {Object} PluginConfig
 * @property {string} [openAiApiKey] - API key for OpenAI used for STT & ChatGPT
 * @property {string} [elevenLabsApiKey] - API key for ElevenLabs used for TTS
 * @property {string} [sttLanguage] - Language code for speech-to-text (e.g., "en" for English)
 * @property {string} [gptModel] - Model for ChatGPT (e.g., "gpt-3.5-turbo" or "gpt-4")
 * @property {number} [silenceThreshold] - Amplitude threshold for ignoring silence
 * @property {string} [voiceId] - Specifies which ElevenLabs voice to use
 * @property {string} [elevenLabsModel] - Model for ElevenLabs (e.g., "eleven_monolingual_v1")
 * @property {string} [systemPrompt] - Default prompt for the AI assistant
 * @property {Array<{ role: "system" | "user" | "assistant"; content: string; }>} [chatContext] - Array of objects representing chat context
 * @property {boolean} [debug] - Flag to enable debug mode
 */
interface PluginConfig {
  openAiApiKey?: string; // for STT & ChatGPT
  elevenLabsApiKey?: string; // for TTS
  sttLanguage?: string; // e.g., "en" for Whisper
  gptModel?: string; // e.g., "gpt-3.5-turbo" or "gpt-4"
  silenceThreshold?: number; // amplitude threshold for ignoring silence
  voiceId?: string; // specify which ElevenLabs voice to use
  elevenLabsModel?: string; // e.g., "eleven_monolingual_v1"
  systemPrompt?: string; // e.g., "You are a helpful AI assistant"
  chatContext?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  debug?: boolean;
}

/**
 * SttTtsPlugin
 * ------------
 * Provides an end-to-end flow of:
 *  - Speech-to-Text (OpenAI Whisper)
 *  - ChatGPT conversation
 *  - Text-to-Speech (ElevenLabs)
 *  - Streams TTS audio frames back to Janus
 *
 * Lifecycle:
 *  - onAttach(...) => minimal references
 *  - init(...) => space or participant has joined in basic mode
 *  - onJanusReady(...) => we have a JanusClient
 *  - onAudioData(...) => receiving PCM frames from speakers
 *  - cleanup(...) => release resources, stop timers, etc.
 */
/**
 * Represents a plugin for speech-to-text and text-to-speech functionality.
 * @implements Plugin
 * @property {Space | SpaceParticipant} spaceOrParticipant - Reference to the space/participant using the plugin.
 * @property {JanusClient} janus - Reference to the Janus client for real-time communication.
 * @property {Logger} logger - Optional logger retrieved from the space or participant.
 */
export class SttTtsPlugin implements Plugin {
  // References to the space/participant and the Janus client
  private spaceOrParticipant?: Space | SpaceParticipant;
  private janus?: JanusClient;

  // Optional logger retrieved from the space or participant
  private logger?: Logger;

  // Credentials & config
  private openAiApiKey?: string;
  private elevenLabsApiKey?: string;
  private sttLanguage = 'en';
  private gptModel = 'gpt-3.5-turbo';
  private voiceId = '21m00Tcm4TlvDq8ikWAM';
  private elevenLabsModel = 'eleven_monolingual_v1';
  private systemPrompt = 'You are a helpful AI assistant.';
  private silenceThreshold = 50;

  /**
   * chatContext accumulates the conversation for GPT:
   *  - system: persona instructions
   *  - user/assistant: running conversation
   */
  private chatContext: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  /**
   * Maps each userId => array of Int16Array PCM chunks
   * Only accumulates data if the speaker is unmuted
   */
  private pcmBuffers = new Map<string, Int16Array[]>();

  /**
   * Tracks which speakers are currently unmuted:
   * userId => true/false
   */
  private speakerUnmuted = new Map<string, boolean>();

  /**
   * TTS queue for sequential playback
   */
  private ttsQueue: string[] = [];
  private isSpeaking = false;

  /**
   * Called immediately after `.use(plugin)`.
   * Usually used for storing references or minimal setup.
   */
  onAttach(params: { space: Space | SpaceParticipant; pluginConfig?: Record<string, any> }): void {
    // Store a reference to the space or participant
    this.spaceOrParticipant = params.space;

    const debugEnabled = params.pluginConfig?.debug ?? false;
    this.logger = new Logger(debugEnabled);

    logger.debug('[SttTtsPlugin] onAttach => plugin attached');
  }

  /**
   * Called after the space/participant has joined in basic mode (listener + chat).
   * This is where we can finalize setup that doesn't require Janus or speaker mode.
   */
  init(params: { space: Space | SpaceParticipant; pluginConfig?: Record<string, any> }): void {
    const config = params.pluginConfig as PluginConfig;

    this.logger?.debug('[SttTtsPlugin] init => finalizing basic setup');

    // Overwrite the local reference with a strong typed one
    this.spaceOrParticipant = params.space;

    // If space/participant has a Janus client already, we can store it,
    // but typically we rely on "onJanusReady" for that.
    this.janus = (this.spaceOrParticipant as any).janusClient;

    // Merge plugin configuration
    this.openAiApiKey = config?.openAiApiKey;
    this.elevenLabsApiKey = config?.elevenLabsApiKey;
    if (config?.sttLanguage) this.sttLanguage = config.sttLanguage;
    if (config?.gptModel) this.gptModel = config.gptModel;
    if (typeof config?.silenceThreshold === 'number') {
      this.silenceThreshold = config.silenceThreshold;
    }
    if (config?.voiceId) this.voiceId = config.voiceId;
    if (config?.elevenLabsModel) this.elevenLabsModel = config.elevenLabsModel;
    if (config?.systemPrompt) this.systemPrompt = config.systemPrompt;
    if (config?.chatContext) {
      this.chatContext = config.chatContext;
    }

    this.logger?.debug('[SttTtsPlugin] Merged config =>', config);

    // Example: watch for "muteStateChanged" events from the space or participant
    this.spaceOrParticipant.on('muteStateChanged', (evt: { userId: string; muted: boolean }) => {
      this.logger?.debug('[SttTtsPlugin] muteStateChanged =>', evt);
      if (evt.muted) {
        // If the user just muted, flush STT
        this.handleMute(evt.userId).catch((err) => {
          this.logger?.error('[SttTtsPlugin] handleMute error =>', err);
        });
      } else {
        // Mark user as unmuted
        this.speakerUnmuted.set(evt.userId, true);
        if (!this.pcmBuffers.has(evt.userId)) {
          this.pcmBuffers.set(evt.userId, []);
        }
      }
    });
  }

  /**
   * Called if/when the plugin needs direct access to a JanusClient.
   * For example, once the participant becomes a speaker or if a host
   * has finished setting up Janus.
   */
  onJanusReady(janusClient: JanusClient): void {
    this.logger?.debug('[SttTtsPlugin] onJanusReady => JanusClient is now available');
    this.janus = janusClient;
  }

  /**
   * onAudioData: triggered for every incoming PCM frame from a speaker.
   * We'll accumulate them if that speaker is currently unmuted.
   */
  onAudioData(data: AudioDataWithUser): void {
    const { userId, samples } = data;
    if (!this.speakerUnmuted.get(userId)) return;

    // Basic amplitude check
    let maxVal = 0;
    for (let i = 0; i < samples.length; i++) {
      const val = Math.abs(samples[i]);
      if (val > maxVal) maxVal = val;
    }
    if (maxVal < this.silenceThreshold) return;

    // Accumulate frames
    const chunks = this.pcmBuffers.get(userId) ?? [];
    chunks.push(samples);
    this.pcmBuffers.set(userId, chunks);
  }

  /**
   * handleMute: called when a speaker goes from unmuted to muted.
   * We'll flush their collected PCM => STT => GPT => TTS => push to Janus
   */
  private async handleMute(userId: string): Promise<void> {
    this.speakerUnmuted.set(userId, false);

    const chunks = this.pcmBuffers.get(userId) || [];
    this.pcmBuffers.set(userId, []); // reset

    if (!chunks.length) {
      this.logger?.debug('[SttTtsPlugin] No audio data => userId=', userId);
      return;
    }

    this.logger?.info(
      `[SttTtsPlugin] Flushing STT buffer => userId=${userId}, chunkCount=${chunks.length}`
    );

    // Merge into one Int16Array
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Int16Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    // Convert to WAV
    const wavPath = await this.convertPcmToWav(merged, 48000);
    this.logger?.debug('[SttTtsPlugin] WAV created =>', wavPath);

    // Whisper STT
    const sttText = await this.transcribeWithOpenAI(wavPath, this.sttLanguage);
    fs.unlinkSync(wavPath); // remove temp

    if (!sttText.trim()) {
      this.logger?.debug('[SttTtsPlugin] No speech recognized => userId=', userId);
      return;
    }
    this.logger?.info(`[SttTtsPlugin] STT => userId=${userId}, text="${sttText}"`);

    // GPT response
    const replyText = await this.askChatGPT(sttText);
    this.logger?.info(`[SttTtsPlugin] GPT => userId=${userId}, reply="${replyText}"`);

    // Send TTS
    await this.speakText(replyText);
  }

  /**
   * speakText: Public method to enqueue a text message for TTS output
   */
  public async speakText(text: string): Promise<void> {
    this.ttsQueue.push(text);

    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.processTtsQueue().catch((err) => {
        this.logger?.error('[SttTtsPlugin] processTtsQueue error =>', err);
      });
    }
  }

  /**
   * processTtsQueue: Drains the TTS queue in order, sending frames to Janus
   */
  private async processTtsQueue(): Promise<void> {
    while (this.ttsQueue.length > 0) {
      const text = this.ttsQueue.shift();
      if (!text) continue;
      try {
        const mp3Buf = await this.elevenLabsTts(text);
        const pcm = await this.convertMp3ToPcm(mp3Buf, 48000);
        await this.streamToJanus(pcm, 48000);
      } catch (err) {
        this.logger?.error('[SttTtsPlugin] TTS streaming error =>', err);
      }
    }
    this.isSpeaking = false;
  }

  /**
   * convertPcmToWav: Creates a temporary WAV file from raw PCM samples
   */
  private convertPcmToWav(samples: Int16Array, sampleRate: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const tmpPath = path.resolve('/tmp', `stt-${Date.now()}.wav`);
      const ff = spawn('ffmpeg', [
        '-f',
        's16le',
        '-ar',
        sampleRate.toString(),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-y',
        tmpPath,
      ]);

      ff.stdin.write(Buffer.from(samples.buffer));
      ff.stdin.end();

      ff.on('close', (code) => {
        if (code === 0) {
          resolve(tmpPath);
        } else {
          reject(new Error(`ffmpeg pcm->wav error code=${code}`));
        }
      });
    });
  }

  /**
   * transcribeWithOpenAI: sends the WAV file to OpenAI Whisper
   */
  private async transcribeWithOpenAI(wavPath: string, language: string): Promise<string> {
    if (!this.openAiApiKey) {
      throw new Error('[SttTtsPlugin] No OpenAI API key');
    }

    this.logger?.info('[SttTtsPlugin] Transcribing =>', wavPath);
    const fileBuffer = fs.readFileSync(wavPath);
    this.logger?.debug('[SttTtsPlugin] WAV size =>', fileBuffer.length);

    const blob = new Blob([fileBuffer], { type: 'audio/wav' });
    const formData = new FormData();
    formData.append('file', blob, path.basename(wavPath));
    formData.append('model', 'whisper-1');
    formData.append('language', language);
    formData.append('temperature', '0');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openAiApiKey}` },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      this.logger?.error('[SttTtsPlugin] OpenAI STT error =>', errText);
      throw new Error(`OpenAI STT => ${resp.status} ${errText}`);
    }

    const data = (await resp.json()) as { text: string };
    return data.text.trim();
  }

  /**
   * askChatGPT: sends user text to GPT, returns the assistant reply
   */
  private async askChatGPT(userText: string): Promise<string> {
    if (!this.openAiApiKey) {
      throw new Error('[SttTtsPlugin] No OpenAI API key (GPT) provided');
    }

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.chatContext,
      { role: 'user', content: userText },
    ];

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.gptModel, messages }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`[SttTtsPlugin] ChatGPT error => ${resp.status} ${errText}`);
    }

    const json = await resp.json();
    const reply = json.choices?.[0]?.message?.content || '';
    // Keep conversation context
    this.chatContext.push({ role: 'user', content: userText });
    this.chatContext.push({ role: 'assistant', content: reply });
    return reply.trim();
  }

  /**
   * elevenLabsTts: fetches MP3 audio from ElevenLabs for a given text
   */
  private async elevenLabsTts(text: string): Promise<Buffer> {
    if (!this.elevenLabsApiKey) {
      throw new Error('[SttTtsPlugin] No ElevenLabs API key');
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: this.elevenLabsModel,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`[SttTtsPlugin] ElevenLabs error => ${resp.status} ${errText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * convertMp3ToPcm: uses ffmpeg to convert an MP3 buffer to raw PCM
   */
  private convertMp3ToPcm(mp3Buf: Buffer, outRate: number): Promise<Int16Array> {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        outRate.toString(),
        '-ac',
        '1',
        'pipe:1',
      ]);

      let raw = Buffer.alloc(0);

      ff.stdout.on('data', (chunk: Buffer) => {
        raw = Buffer.concat([raw, chunk]);
      });
      ff.stderr.on('data', () => {
        // ignoring ffmpeg stderr
      });
      ff.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg mp3->pcm error code=${code}`));
          return;
        }
        const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        resolve(samples);
      });

      ff.stdin.write(mp3Buf);
      ff.stdin.end();
    });
  }

  /**
   * streamToJanus: push PCM frames to Janus in small increments (~10ms).
   */
  private async streamToJanus(samples: Int16Array, sampleRate: number): Promise<void> {
    if (!this.janus) {
      this.logger?.warn('[SttTtsPlugin] No JanusClient available, cannot send TTS audio');
      return;
    }

    const frameSize = Math.floor(sampleRate * 0.01); // 10ms => e.g. 480 @ 48kHz

    for (let offset = 0; offset + frameSize <= samples.length; offset += frameSize) {
      const frame = new Int16Array(frameSize);
      frame.set(samples.subarray(offset, offset + frameSize));
      this.janus.pushLocalAudio(frame, sampleRate, 1);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * setSystemPrompt: update the GPT system prompt at runtime
   */
  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    this.logger?.info('[SttTtsPlugin] setSystemPrompt =>', prompt);
  }

  /**
   * setGptModel: switch GPT model (e.g. "gpt-4")
   */
  public setGptModel(model: string): void {
    this.gptModel = model;
    this.logger?.info('[SttTtsPlugin] setGptModel =>', model);
  }

  /**
   * addMessage: manually add a system/user/assistant message to the chat context
   */
  public addMessage(role: 'system' | 'user' | 'assistant', content: string): void {
    this.chatContext.push({ role, content });
    this.logger?.debug(`[SttTtsPlugin] addMessage => role=${role}, content="${content}"`);
  }

  /**
   * clearChatContext: resets the GPT conversation
   */
  public clearChatContext(): void {
    this.chatContext = [];
    this.logger?.debug('[SttTtsPlugin] clearChatContext => done');
  }

  /**
   * cleanup: release resources when the space/participant is stopping or plugin removed
   */
  cleanup(): void {
    this.logger?.info('[SttTtsPlugin] cleanup => releasing resources');

    this.pcmBuffers.clear();
    this.speakerUnmuted.clear();
    this.ttsQueue = [];
    this.isSpeaking = false;
  }
}
