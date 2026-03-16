import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { SamTTSService } from "../services/SamTTSService";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("SamTTSService", () => {
  let runtime: IAgentRuntime;

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  describe("metadata", () => {
    it("has correct service type", () => {
      expect(SamTTSService.serviceType).toBe("SAM_TTS");
    });
  });

  describe("initialization", () => {
    it("can be constructed with runtime", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);
      expect(service).toBeInstanceOf(SamTTSService);
    });

    it("can be started via class method", async () => {
      runtime = await createTestRuntime();
      const service = await SamTTSService.start(runtime);
      expect(service).toBeInstanceOf(SamTTSService);
    });

    it("can be stopped", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);
      await service.stop(); // Should complete without error
    });
  });

  describe("generateAudio", () => {
    it("returns Uint8Array", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);
      const audio = service.generateAudio("Hello");
      expect(audio).toBeInstanceOf(Uint8Array);
    });

    it("generates non-empty audio", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);
      const audio = service.generateAudio("Hello");
      expect(audio.length).toBeGreaterThan(0);
    });

    it("applies speed option", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const slow = service.generateAudio("Test", { speed: 40 });
      const fast = service.generateAudio("Test", { speed: 120 });

      expect(slow.length).not.toBe(fast.length);
    });

    it("applies pitch option", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const low = service.generateAudio("Test", { pitch: 30 });
      const high = service.generateAudio("Test", { pitch: 100 });

      // Audio should be different
      expect(low).not.toEqual(high);
    });

    it("uses default options when none provided", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const audio = service.generateAudio("Test");
      expect(audio.length).toBeGreaterThan(0);
    });
  });

  describe("speakText", () => {
    it("returns audio buffer", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);
      const audio = await service.speakText("Hello");
      expect(audio).toBeInstanceOf(Uint8Array);
      expect(audio.length).toBeGreaterThan(0);
    });

    it("accepts custom options", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);
      const audio = await service.speakText("Hello", { speed: 100, pitch: 80 });
      expect(audio).toBeInstanceOf(Uint8Array);
    });
  });

  describe("createWAVBuffer", () => {
    it("creates valid WAV header", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const audioData = new Uint8Array([128, 128, 128, 128]);
      const wav = service.createWAVBuffer(audioData);

      // Check RIFF header
      expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
      // Check WAVE format
      expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
      // Check fmt chunk
      expect(String.fromCharCode(...wav.slice(12, 16))).toBe("fmt ");
      // Check data chunk
      expect(String.fromCharCode(...wav.slice(36, 40))).toBe("data");
    });

    it("has correct size (44 byte header + data)", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const audioData = new Uint8Array(100);
      const wav = service.createWAVBuffer(audioData);

      expect(wav.length).toBe(144); // 44 + 100
    });

    it("accepts custom sample rate", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const audioData = new Uint8Array([128]);
      const wav = service.createWAVBuffer(audioData, 44100);

      expect(wav.length).toBe(45); // 44 + 1
    });

    it("handles empty audio data", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      const wav = service.createWAVBuffer(new Uint8Array(0));

      expect(wav.length).toBe(44); // just header
      expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    });
  });

  describe("capabilityDescription", () => {
    it("returns description with SAM", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      expect(service.capabilityDescription).toContain("SAM");
    });

    it("returns description with TTS", async () => {
      runtime = await createTestRuntime();
      const service = new SamTTSService(runtime);

      expect(service.capabilityDescription).toContain("TTS");
    });
  });
});
