/**
 * Exercises the production diarization status control through its dedicated
 * local-agent ElizaClient while native capture collaborators are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientBase: undefined as string | undefined,
  clientFetch: vi.fn(),
}));

vi.mock("../api", () => ({
  ElizaClient: class {
    fetch = mocks.clientFetch;

    constructor(baseUrl?: string) {
      mocks.clientBase = baseUrl;
    }
  },
}));

vi.mock("../bridge/native-plugins", () => ({
  getTalkModePlugin: () => ({}),
}));

vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_LOCAL_AGENT_API_BASE: "http://127.0.0.1:3000",
}));

vi.mock("./audio-frame-pump", () => ({
  AudioFramePump: class {},
}));

import { installDiarizationPumpHarness } from "./audio-frame-diarization-harness";

describe("diarization-harness status request deadline", () => {
  beforeEach(() => {
    mocks.clientFetch.mockReset();
  });

  it("pins the production status control to the bounded local-agent client", async () => {
    mocks.clientFetch.mockResolvedValue({ ok: true, framesReceived: 3 });

    await expect(
      installDiarizationPumpHarness().status(),
    ).resolves.toMatchObject({ framesReceived: 3 });

    expect(mocks.clientBase).toBe("http://127.0.0.1:3000");
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      "/api/voice/audio-frames/status",
      { method: "GET", headers: { accept: "application/json" } },
      { timeoutMs: 15_000 },
    );
  });

  it("surfaces a bounded-client failure to the diagnostic caller", async () => {
    const timeout = new Error("Request timed out after 15000ms");
    mocks.clientFetch.mockRejectedValue(timeout);

    await expect(installDiarizationPumpHarness().status()).rejects.toBe(
      timeout,
    );
  });
});
