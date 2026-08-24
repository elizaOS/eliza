/**
 * @vitest-environment jsdom
 * Unit tests for hold-to-talk audible cues synthesis via WebAudio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playCaptureSendCue, playCaptureStartCue } from "../capture-cues.ts";

describe("capture-cues", () => {
  let mockOscillator: {
    type: string;
    frequency: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  };

  let mockGain: {
    gain: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };

  let mockAudioContext: {
    state: string;
    currentTime: number;
    destination: Record<string, unknown>;
    createOscillator: ReturnType<typeof vi.fn>;
    createGain: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockOscillator = {
      type: "sine",
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };

    mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockAudioContext = {
      state: "running",
      currentTime: 10,
      destination: {},
      createOscillator: vi.fn(() => mockOscillator),
      createGain: vi.fn(() => mockGain),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    class MockAudioContext {
      state = mockAudioContext.state;
      currentTime = mockAudioContext.currentTime;
      destination = mockAudioContext.destination;
      createOscillator = mockAudioContext.createOscillator;
      createGain = mockAudioContext.createGain;
      resume = mockAudioContext.resume;
    }

    Object.defineProperty(window, "AudioContext", {
      value: MockAudioContext,
      configurable: true,
      writable: true,
    });
  });

  it("plays rising ping for capture start cue with expected frequencies and peak gain", () => {
    playCaptureStartCue();

    expect(mockAudioContext.createOscillator).toHaveBeenCalled();
    expect(mockAudioContext.createGain).toHaveBeenCalled();
    expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(
      520,
      10,
    );
    expect(
      mockOscillator.frequency.exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(780, expect.closeTo(10.14, 2));
    expect(mockGain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      0.06,
      expect.closeTo(10.012, 3),
    );
    expect(mockOscillator.start).toHaveBeenCalledWith(10);
    expect(mockOscillator.stop).toHaveBeenCalledWith(expect.closeTo(10.16, 2));

    if (mockOscillator.onended) {
      mockOscillator.onended();
      expect(mockOscillator.disconnect).toHaveBeenCalled();
      expect(mockGain.disconnect).toHaveBeenCalled();
    }
  });

  it("plays falling tick for capture send cue with expected frequencies and peak gain", () => {
    playCaptureSendCue();

    expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(
      660,
      10,
    );
    expect(
      mockOscillator.frequency.exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(440, expect.closeTo(10.11, 2));
    expect(mockGain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      0.04,
      expect.closeTo(10.012, 3),
    );
  });
});
