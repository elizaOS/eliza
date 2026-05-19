// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/runtime-mode-client", () => ({
  fetchRuntimeModeSnapshot: vi.fn(),
}));

import { fetchRuntimeModeSnapshot } from "../api/runtime-mode-client";
import {
  type UseDefaultProviderPresetsResult,
  useDefaultProviderPresets,
} from "./useDefaultProviderPresets";
import { __resetRuntimeModeCacheForTests } from "./useRuntimeMode";

const fetchMock = vi.mocked(fetchRuntimeModeSnapshot);

function HookProbe(props: {
  onState: (result: UseDefaultProviderPresetsResult) => void;
  options?: Parameters<typeof useDefaultProviderPresets>[0];
}): null {
  const result = useDefaultProviderPresets(props.options);
  props.onState(result);
  return null;
}

beforeEach(() => {
  __resetRuntimeModeCacheForTests();
  fetchMock.mockReset();
});

afterEach(() => {
  __resetRuntimeModeCacheForTests();
});

describe("useDefaultProviderPresets", () => {
  it("desktop + local mode picks on-device TTS+ASR", async () => {
    fetchMock.mockResolvedValueOnce({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    const seen: UseDefaultProviderPresetsResult[] = [];
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{ platformOverride: "desktop" }}
      />,
    );
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.loading).toBe(false);
    });
    const last = seen[seen.length - 1];
    expect(last?.defaults).toEqual({
      tts: "local-inference",
      asr: "local-inference",
    });
    expect(last?.platform).toBe("desktop");
    expect(last?.runtimeMode).toBe("local");
  });

  it("mobile + local mode picks Eliza Cloud for both TTS+ASR", async () => {
    fetchMock.mockResolvedValueOnce({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    const seen: UseDefaultProviderPresetsResult[] = [];
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{ platformOverride: "mobile" }}
      />,
    );
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.loading).toBe(false);
    });
    const last = seen[seen.length - 1];
    expect(last?.defaults).toEqual({
      tts: "elevenlabs",
      asr: "eliza-cloud",
    });
    expect(last?.platform).toBe("mobile");
  });

  it("cloud agent on any device picks Eliza Cloud", async () => {
    fetchMock.mockResolvedValueOnce({
      mode: "cloud",
      deploymentRuntime: "cloud",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    const seen: UseDefaultProviderPresetsResult[] = [];
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{ platformOverride: "desktop" }}
      />,
    );
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.loading).toBe(false);
    });
    const last = seen[seen.length - 1];
    expect(last?.defaults).toEqual({
      tts: "elevenlabs",
      asr: "eliza-cloud",
    });
    expect(last?.runtimeMode).toBe("cloud");
  });

  it("remote-controller picks Eliza Cloud", async () => {
    fetchMock.mockResolvedValueOnce({
      mode: "remote",
      deploymentRuntime: "remote",
      isRemoteController: true,
      remoteApiBaseConfigured: true,
    });
    const seen: UseDefaultProviderPresetsResult[] = [];
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{ platformOverride: "desktop" }}
      />,
    );
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.loading).toBe(false);
    });
    const last = seen[seen.length - 1];
    expect(last?.runtimeMode).toBe("remote");
    expect(last?.defaults).toEqual({
      tts: "elevenlabs",
      asr: "eliza-cloud",
    });
  });

  it("falls back to cloud defaults while the snapshot is still loading", async () => {
    // Never resolve the mock so the hook stays in loading.
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const seen: UseDefaultProviderPresetsResult[] = [];
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{ platformOverride: "desktop" }}
      />,
    );
    const first = seen[0];
    expect(first?.loading).toBe(true);
    // Loading state still resolves a safe default — Eliza Cloud everything.
    expect(first?.defaults).toEqual({
      tts: "elevenlabs",
      asr: "eliza-cloud",
    });
  });

  it("runtimeModeOverride bypasses the network call entirely", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const seen: UseDefaultProviderPresetsResult[] = [];
    render(
      <HookProbe
        onState={(r) => seen.push(r)}
        options={{
          platformOverride: "desktop",
          runtimeModeOverride: "local-only",
        }}
      />,
    );
    const last = seen[seen.length - 1];
    expect(last?.runtimeMode).toBe("local-only");
    expect(last?.defaults).toEqual({
      tts: "local-inference",
      asr: "local-inference",
    });
  });
});
