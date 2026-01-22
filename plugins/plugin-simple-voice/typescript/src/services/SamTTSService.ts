import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import SamJs from "sam-js";
import {
  DEFAULT_SAM_OPTIONS,
  type HardwareBridgeService,
  SAMServiceType,
  type SamTTSOptions,
} from "../types";

export class SamTTSService extends Service {
  static serviceType = SAMServiceType.SAM_TTS;
  protected declare runtime: IAgentRuntime;

  static async start(runtime: IAgentRuntime): Promise<SamTTSService> {
    logger.info("[SAM-TTS] Service initialized");
    return new SamTTSService(runtime);
  }

  async stop(): Promise<void> {
    logger.info("[SAM-TTS] Service stopped");
  }

  generateAudio(text: string, options: Partial<SamTTSOptions> = {}): Uint8Array {
    const opts = { ...DEFAULT_SAM_OPTIONS, ...options };

    logger.info(
      `[SAM-TTS] Synthesizing: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`
    );

    const sam = new SamJs({
      speed: opts.speed,
      pitch: opts.pitch,
      throat: opts.throat,
      mouth: opts.mouth,
    });

    const audioBuffer = sam.buf8(text) as Uint8Array;
    logger.info(`[SAM-TTS] Generated ${audioBuffer.length} bytes`);

    return audioBuffer;
  }

  async speakText(text: string, options: Partial<SamTTSOptions> = {}): Promise<Uint8Array> {
    const audioBuffer = this.generateAudio(text, options);
    const wavBuffer = this.createWAVBuffer(audioBuffer);

    const hardwareBridge = this.runtime.getService<HardwareBridgeService>("hardwareBridge");

    if (hardwareBridge) {
      logger.info("[SAM-TTS] Sending to hardware bridge...");
      await hardwareBridge.sendAudioData(wavBuffer);
      logger.info("[SAM-TTS] Audio sent");
    }

    return audioBuffer;
  }

  createWAVBuffer(audioData: Uint8Array, sampleRate = 22050): Uint8Array {
    const dataSize = audioData.length;
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);

    buffer.set([0x52, 0x49, 0x46, 0x46], 0);
    view.setUint32(4, 36 + dataSize, true);
    buffer.set([0x57, 0x41, 0x56, 0x45], 8);

    buffer.set([0x66, 0x6d, 0x74, 0x20], 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);

    buffer.set([0x64, 0x61, 0x74, 0x61], 36);
    view.setUint32(40, dataSize, true);
    buffer.set(audioData, 44);

    return buffer;
  }

  get capabilityDescription(): string {
    return "SAM TTS: Retro 1980s text-to-speech synthesis";
  }
}
