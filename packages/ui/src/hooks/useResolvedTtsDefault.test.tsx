// @vitest-environment jsdom

/**
 * Drives the real `useResolvedTtsDefault` hook + `useDefaultProviderPresets` +
 * `resolveDefaultTtsProvider` against a mocked runtime-mode snapshot and a
 * mocked on-device readiness probe. Asserts the capability-aware default chain
 * per platform/config: on-device Kokoro when staged, else Eliza Cloud Kokoro,
 * else ElevenLabs (key), else browser SpeechSynthesis — and that the probe only
 * fires when the platform/mode would use an on-device voice.
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/runtime-mode-client", () => ({
  fetchRuntimeModeSnapshot: vi.fn(),
}));

vi.mock("../voice/local-tts-status", () => ({
  isLocalInferenceTtsReady: vi.fn(),
}));

import {
  fetchRuntimeModeSnapshot,
  type RuntimeModeSnapshot,
} from "../api/runtime-mode-client";
import { isLocalInferenceTtsReady } from "../voice/local-tts-status";
import { BROWSER_TTS_PROVIDER } from "../voice/voice-provider-defaults";
import {
  type UseResolvedTtsDefaultResult,
  useResolvedTtsDefault,
} from "./useResolvedTtsDefault";
import { __resetRuntimeModeCacheForTests } from "./useRuntimeMode";

const fetchMock = vi.mocked(fetchRuntimeModeSnapshot);
const ttsReadyMock = vi.mocked(isLocalInferenceTtsReady);

function HookProbe(props: {
  onState: (result: UseResolvedTtsDefaultResult) => void;
  options: Parameters<typeof useResolvedTtsDefault>[0];
}): null {
  const result = useResolvedTtsDefault(props.options);
  props.onState(result);
  return null;
}

async function resolveOnce(
  options: Parameters<typeof useResolvedTtsDefault>[0],
  runtimeMode: RuntimeModeSnapshot,
): Promise<UseResolvedTtsDefaultResult> {
  fetchMock.mockResolvedValueOnce(runtimeMode);
  const seen: UseResolvedTtsDefaultResult[] = [];
  render(<HookProbe onState={(r) => seen.push(r)} options={options} />);
  await waitFor(() => {
    expect(seen[seen.length - 1]?.runtimeMode).toBe(runtimeMode.mode);
  });
  return seen[seen.length - 1] as UseResolvedTtsDefaultResult;
}

beforeEach(() => {
  __resetRuntimeModeCacheForTests();
  fetchMock.mockReset();
  ttsReadyMock.mockReset();
  ttsReadyMock.mockResolvedValue(false);
});

afterEach(() => {
  __resetRuntimeModeCacheForTests();
});

describe("useResolvedTtsDefault", () => {
  it("desktop-local with staged on-device Kokoro resolves to local-inference", async () => {
    const last = await resolveOnce(
      {
        platformOverride: "desktop",
        cloudVoiceAvailable: true,
        elevenLabsKeyConfigured: true,
        localInferenceTtsReadyOverride: true,
      },
      {
        mode: "local",
        deploymentRuntime: "local",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(last.provider).toBe("local-inference");
  });

  it("desktop-local without a staged voice falls to Eliza Cloud Kokoro", async () => {
    const last = await resolveOnce(
      {
        platformOverride: "desktop",
        cloudVoiceAvailable: true,
        elevenLabsKeyConfigured: true,
        localInferenceTtsReadyOverride: false,
      },
      {
        mode: "local",
        deploymentRuntime: "local",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(last.provider).toBe("eliza-cloud");
  });

  it("cloud agent with a session resolves to Eliza Cloud Kokoro", async () => {
    const last = await resolveOnce(
      {
        platformOverride: "web",
        cloudVoiceAvailable: true,
        elevenLabsKeyConfigured: false,
      },
      {
        mode: "cloud",
        deploymentRuntime: "cloud",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(last.provider).toBe("eliza-cloud");
  });

  it("cloud agent with NO session but an ElevenLabs key resolves to elevenlabs", async () => {
    const last = await resolveOnce(
      {
        platformOverride: "web",
        cloudVoiceAvailable: false,
        elevenLabsKeyConfigured: true,
      },
      {
        mode: "cloud",
        deploymentRuntime: "cloud",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(last.provider).toBe("elevenlabs");
  });

  it("with no capabilities at all resolves to browser SpeechSynthesis", async () => {
    const last = await resolveOnce(
      {
        platformOverride: "web",
        cloudVoiceAvailable: false,
        elevenLabsKeyConfigured: false,
      },
      {
        mode: "cloud",
        deploymentRuntime: "cloud",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(last.provider).toBe(BROWSER_TTS_PROVIDER);
  });

  it("probes on-device readiness only on desktop/mobile-local surfaces", async () => {
    ttsReadyMock.mockResolvedValue(true);
    await resolveOnce(
      {
        platformOverride: "desktop",
        cloudVoiceAvailable: false,
        elevenLabsKeyConfigured: false,
      },
      {
        mode: "local",
        deploymentRuntime: "local",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(ttsReadyMock).toHaveBeenCalled();
  });

  it("does NOT probe on-device readiness for a cloud agent", async () => {
    await resolveOnce(
      {
        platformOverride: "web",
        cloudVoiceAvailable: true,
        elevenLabsKeyConfigured: false,
      },
      {
        mode: "cloud",
        deploymentRuntime: "cloud",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      },
    );
    expect(ttsReadyMock).not.toHaveBeenCalled();
  });

  it("upgrades to on-device Kokoro once the real probe reports ready", async () => {
    ttsReadyMock.mockResolvedValue(true);
    const seen: UseResolvedTtsDefaultResult[] = [];
    fetchMock.mockResolvedValueOnce({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{
          platformOverride: "desktop",
          cloudVoiceAvailable: false,
          elevenLabsKeyConfigured: false,
        }}
      />,
    );
    // The probe is async; the default upgrades to local-inference once it
    // resolves. Before then the terminal browser fallback is safe.
    await waitFor(() => {
      expect(seen[seen.length - 1]?.provider).toBe("local-inference");
    });
    expect(ttsReadyMock).toHaveBeenCalled();
  });
});
