import { describe, expect, it } from "vitest";
import {
  readVoiceBackendModeFromEnv,
  selectVoiceBackend,
} from "../runtime-selection";

describe("selectVoiceBackend", () => {
  it("forces Kokoro when mode=kokoro and artifacts are present", () => {
    const d = selectVoiceBackend({
      mode: "kokoro",
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("kokoro");
    expect(d.reason).toMatch(/forced/);
  });

  it("throws when mode=kokoro but artifacts are missing", () => {
    expect(() =>
      selectVoiceBackend({
        mode: "kokoro",
        kokoroAvailable: false,
        omnivoiceAvailable: true,
      }),
    ).toThrow(/Kokoro/);
  });

  it("forces OmniVoice when mode=omnivoice", () => {
    const d = selectVoiceBackend({
      mode: "omnivoice",
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("omnivoice");
  });

  it("auto: requireVoiceCloning routes to OmniVoice", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      requireVoiceCloning: true,
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("omnivoice");
    expect(d.reason).toMatch(/cloning/);
  });

  it("auto: requireVoiceCloning with no OmniVoice throws", () => {
    expect(() =>
      selectVoiceBackend({
        mode: "auto",
        requireVoiceCloning: true,
        kokoroAvailable: true,
        omnivoiceAvailable: false,
      }),
    ).toThrow(/cloning/);
  });

  it("auto: low targetTtfaMs (<200) prefers Kokoro", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      targetTtfaMs: 120,
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("kokoro");
    expect(d.reason).toMatch(/97ms/);
  });

  it("auto: low targetTtfaMs with no Kokoro falls back to OmniVoice", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      targetTtfaMs: 120,
      kokoroAvailable: false,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("omnivoice");
  });

  it("auto: Kokoro RTF beats OmniVoice by ≥10% → Kokoro", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      kokoroRtf: 2.5,
      omnivoiceRtf: 2.0,
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("kokoro");
  });

  it("auto: Kokoro RTF only marginally better → OmniVoice default", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      kokoroRtf: 2.05,
      omnivoiceRtf: 2.0,
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("omnivoice");
  });

  it("auto: Kokoro RTF measured but OmniVoice unmeasured → Kokoro", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      kokoroRtf: 1.5,
      omnivoiceRtf: null,
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("kokoro");
  });

  it("auto: OmniVoice missing but Kokoro present → Kokoro", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      kokoroAvailable: true,
      omnivoiceAvailable: false,
    });
    expect(d.backend).toBe("kokoro");
  });

  it("auto: neither backend available throws", () => {
    expect(() =>
      selectVoiceBackend({
        mode: "auto",
        kokoroAvailable: false,
        omnivoiceAvailable: false,
      }),
    ).toThrow(/no TTS backend/);
  });

  it("auto: default (no overrides) picks OmniVoice", () => {
    const d = selectVoiceBackend({
      mode: "auto",
      kokoroAvailable: true,
      omnivoiceAvailable: true,
    });
    expect(d.backend).toBe("omnivoice");
    expect(d.reason).toMatch(/default/);
  });
});

describe("readVoiceBackendModeFromEnv", () => {
  it("returns undefined when env var is unset", () => {
    expect(readVoiceBackendModeFromEnv({})).toBeUndefined();
  });

  it("parses each valid value", () => {
    expect(readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "kokoro" })).toBe(
      "kokoro",
    );
    expect(
      readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "OMNIVOICE" }),
    ).toBe("omnivoice");
    expect(readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "auto" })).toBe(
      "auto",
    );
  });

  it("throws on an invalid value", () => {
    expect(() =>
      readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "garbage" }),
    ).toThrow();
  });
});
