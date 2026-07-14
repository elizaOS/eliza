// @vitest-environment jsdom

// Unit tests for the shared-tier voice fallback (#15395). Covers:
//   (a) shared-base detection → v1 route selection (and dedicated → null)
//   (b) request/response adaptation (STT multipart body + { transcript } parse)
//   (c) the cheap mic-affordance guard (dedicated always available; shared
//       available only with a resolvable origin)

import { afterEach, describe, expect, it, vi } from "vitest";

// getElizaApiBase is a window-scoped accessor re-exported from @elizaos/shared.
// Mock the local re-export so we can drive the "active agent base" per-test.
vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: vi.fn<() => string | undefined>(),
}));

import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import { getElizaApiBase } from "../utils/eliza-globals";
import {
  buildSharedRuntimeSttBody,
  configuredCloudVoiceOrigin,
  currentSharedRuntimeVoiceOrigin,
  isVoiceTargetResolvableForActiveAgent,
  parseSharedRuntimeSttResponse,
  resolveForcedCloudTtsRoute,
  sharedRuntimeSttUrl,
  sharedRuntimeTtsUrl,
  sharedRuntimeVoiceOrigin,
} from "./shared-runtime-voice";

const getElizaApiBaseMock = vi.mocked(getElizaApiBase);

afterEach(() => {
  vi.clearAllMocks();
  setBootConfig(DEFAULT_BOOT_CONFIG);
});

describe("sharedRuntimeVoiceOrigin (shared-base detection)", () => {
  it("derives the cloud-worker origin from a shared-runtime agent base", () => {
    expect(
      sharedRuntimeVoiceOrigin(
        "https://api.elizacloud.ai/api/v1/eliza/agents/cad3c071",
      ),
    ).toBe("https://api.elizacloud.ai");
  });

  it("handles the legacy /bridge suffix (normalized away) and trailing slash", () => {
    expect(
      sharedRuntimeVoiceOrigin(
        "https://api.elizacloud.ai/api/v1/eliza/agents/abc/bridge/",
      ),
    ).toBe("https://api.elizacloud.ai");
  });

  it("preserves a cloud-base path prefix that precedes the shared-agent tail", () => {
    expect(
      sharedRuntimeVoiceOrigin(
        "https://host.example/gw/api/v1/eliza/agents/xyz",
      ),
    ).toBe("https://host.example/gw");
  });

  it("returns null for a dedicated-subdomain base (no behavior change)", () => {
    expect(
      sharedRuntimeVoiceOrigin("https://cad3c071.elizacloud.ai"),
    ).toBeNull();
  });

  it("returns null for a raw bridge IP / non-shared base", () => {
    expect(sharedRuntimeVoiceOrigin("http://127.0.0.1:3000")).toBeNull();
    expect(
      sharedRuntimeVoiceOrigin("https://api.elizacloud.ai/api/v1/eliza/agents"),
    ).toBeNull();
  });

  it("returns null for blank / undefined input", () => {
    expect(sharedRuntimeVoiceOrigin(undefined)).toBeNull();
    expect(sharedRuntimeVoiceOrigin("")).toBeNull();
    expect(sharedRuntimeVoiceOrigin("   ")).toBeNull();
  });

  it("currentSharedRuntimeVoiceOrigin reads the active agent base", () => {
    getElizaApiBaseMock.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
    );
    expect(currentSharedRuntimeVoiceOrigin()).toBe("https://api.elizacloud.ai");

    getElizaApiBaseMock.mockReturnValue("https://abc.elizacloud.ai");
    expect(currentSharedRuntimeVoiceOrigin()).toBeNull();
  });
});

describe("v1 route URL builders", () => {
  it("builds the tts + stt URLs off the derived origin", () => {
    expect(sharedRuntimeTtsUrl("https://api.elizacloud.ai")).toBe(
      "https://api.elizacloud.ai/api/v1/voice/tts",
    );
    expect(sharedRuntimeSttUrl("https://api.elizacloud.ai/")).toBe(
      "https://api.elizacloud.ai/api/v1/voice/stt",
    );
  });
});

describe("configuredCloudVoiceOrigin (boot-config cloud worker origin, #16116)", () => {
  it("returns the boot-config cloud origin (default production)", () => {
    setBootConfig({ branding: {}, cloudApiBase: "https://elizacloud.ai" });
    expect(configuredCloudVoiceOrigin()).toBe("https://elizacloud.ai");
  });

  it("honors a staging/custom origin (not hardcoded to production)", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    expect(configuredCloudVoiceOrigin()).toBe("https://staging.elizacloud.ai");
  });

  it("strips a trailing /api/v1 and trailing slashes", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api.example.dev/api/v1/",
    });
    expect(configuredCloudVoiceOrigin()).toBe("https://api.example.dev");
  });

  it("returns null for a blank or non-https cloud base", () => {
    setBootConfig({ branding: {}, cloudApiBase: "   " });
    expect(configuredCloudVoiceOrigin()).toBeNull();
    setBootConfig({ branding: {}, cloudApiBase: "ftp://nope.example" });
    expect(configuredCloudVoiceOrigin()).toBeNull();
  });
});

describe("resolveForcedCloudTtsRoute (#16116 direct-cloud routing)", () => {
  const PROXY = "http://127.0.0.1:31337/api/tts/cloud";

  it("routes forced-cloud DIRECTLY to the cloud worker with the cloud bearer", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: "on-device-agent-token",
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: "cloud-steward-jwt",
    });
    expect(route.via).toBe("direct-cloud");
    expect(route.url).toBe("https://elizacloud.ai/api/v1/voice/tts");
    // NOT the on-device proxy — that is the whole point of the fix.
    expect(route.url).not.toContain("/api/tts/cloud");
    // Carries the CLOUD session bearer, not the on-device agent token.
    expect(route.bearer).toBe("cloud-steward-jwt");
  });

  it("targets the configured staging origin (no hardcoded production)", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: null,
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://staging.elizacloud.ai",
      cloudSessionToken: "jwt",
    });
    expect(route.url).toBe("https://staging.elizacloud.ai/api/v1/voice/tts");
  });

  it("preserves the on-device proxy when no cloud session token is available", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: "on-device-agent-token",
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: null,
    });
    expect(route.via).toBe("on-device-proxy");
    expect(route.url).toBe(PROXY);
    expect(route.bearer).toBe("on-device-agent-token");
  });

  it("preserves the on-device proxy when no configured cloud origin is available", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: "on-device-agent-token",
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: null,
      cloudSessionToken: "jwt",
    });
    expect(route.via).toBe("on-device-proxy");
    expect(route.url).toBe(PROXY);
  });

  it("treats a blank cloud session token as unavailable (proxy preserved)", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: "on-device-agent-token",
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: "   ",
    });
    expect(route.via).toBe("on-device-proxy");
    expect(route.url).toBe(PROXY);
  });

  it("omits voiceId/modelId from the direct route when the caller knows none (worker default = proxy default)", () => {
    // The proxy injects LEGACY_DEFAULT_ELEVENLABS_VOICE_ID, which the worker's
    // provider selection treats as "unpinned" — identical to omitting voiceId,
    // so a bare direct body keeps voice parity in the default setup.
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: null,
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: "jwt",
    });
    expect(route.via).toBe("direct-cloud");
    expect(route.voiceId).toBeUndefined();
    expect(route.modelId).toBeUndefined();
  });

  it("carries a caller-known voice/model pin into the direct route (parity seam)", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: null,
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: "jwt",
      voiceId: "  custom-voice-id  ",
      modelId: "eleven_flash_v2_5",
    });
    expect(route.via).toBe("direct-cloud");
    expect(route.voiceId).toBe("custom-voice-id");
    expect(route.modelId).toBe("eleven_flash_v2_5");
    // Blank pins are treated as absent, never sent as empty strings.
    const blank = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: null,
      sharedRuntimeOrigin: null,
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: "jwt",
      voiceId: "   ",
      modelId: null,
    });
    expect(blank.voiceId).toBeUndefined();
    expect(blank.modelId).toBeUndefined();
  });

  it("leaves the shared-runtime path unchanged (targets the active base, #15395)", () => {
    const route = resolveForcedCloudTtsRoute({
      proxyUrl: PROXY,
      proxyBearer: "active-base-token",
      sharedRuntimeOrigin: "https://api.elizacloud.ai",
      configuredCloudOrigin: "https://elizacloud.ai",
      cloudSessionToken: "cloud-steward-jwt",
    });
    expect(route.via).toBe("shared-runtime");
    expect(route.url).toBe("https://api.elizacloud.ai/api/v1/voice/tts");
    // Shared-tier keeps its active-base token; it is not re-authed to the
    // steward bearer here.
    expect(route.bearer).toBe("active-base-token");
  });
});

describe("STT request/response adaptation", () => {
  it("builds a multipart body with the WAV as an `audio` File (audio/wav)", () => {
    const wav = new Uint8Array([82, 73, 70, 70]); // "RIFF"
    const form = buildSharedRuntimeSttBody(wav);
    const file = form.get("audio");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("speech.wav");
    expect((file as File).type).toBe("audio/wav");
    expect((file as File).size).toBe(wav.byteLength);
  });

  it("parses the v1 `{ transcript }` response shape (trimmed)", () => {
    expect(parseSharedRuntimeSttResponse({ transcript: "  hi there " })).toBe(
      "hi there",
    );
  });

  it("tolerates a `{ text }` fallback shape", () => {
    expect(parseSharedRuntimeSttResponse({ text: " fallback " })).toBe(
      "fallback",
    );
  });

  it("returns '' for missing/blank/malformed bodies (caller enforces fail-loud)", () => {
    expect(parseSharedRuntimeSttResponse({ transcript: "   " })).toBe("");
    expect(parseSharedRuntimeSttResponse({})).toBe("");
    expect(parseSharedRuntimeSttResponse(null)).toBe("");
    expect(parseSharedRuntimeSttResponse("not-json")).toBe("");
    expect(parseSharedRuntimeSttResponse({ transcript: 42 })).toBe("");
  });
});

describe("isVoiceTargetResolvableForActiveAgent (mic-affordance guard)", () => {
  it("is true for a dedicated agent (defers to existing capture gate)", () => {
    getElizaApiBaseMock.mockReturnValue("https://abc.elizacloud.ai");
    expect(isVoiceTargetResolvableForActiveAgent()).toBe(true);
  });

  it("is true when no active base is set yet (never suppress the dedicated path)", () => {
    getElizaApiBaseMock.mockReturnValue(undefined);
    expect(isVoiceTargetResolvableForActiveAgent()).toBe(true);
  });

  it("is true for a shared agent with a resolvable https v1 origin", () => {
    getElizaApiBaseMock.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
    );
    expect(isVoiceTargetResolvableForActiveAgent()).toBe(true);
  });
});
