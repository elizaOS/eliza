// @vitest-environment jsdom
import type { PermissionId } from "@elizaos/core/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { walkthroughMemory } from "./permission-walkthrough";

const registry = {
  check: vi.fn(),
  request: vi.fn(),
};
vi.mock("../../api/client", () => ({
  client: { openPermissionSettings: vi.fn(async () => {}) },
}));
vi.mock("../../platform/init", () => ({
  isNative: false,
  isDesktopPlatform: () => false,
}));
vi.mock("../../platform/desktop-permissions-client", () => ({
  checkDesktopPermissionFresh: vi.fn(),
}));
vi.mock("../../platform/mobile-permissions-client", () => ({
  createMobileSignalsPermissionsRegistry: () => registry,
  openMobilePermissionSettings: vi.fn(async () => {}),
}));
vi.mock("../composites/chat/permission-card.helpers", () => ({
  createClientPermissionsRegistry: () => registry,
}));

const { usePermissionPriming } = await import("./use-permission-priming");

const mapStore = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};
const ids: PermissionId[] = ["microphone", "speech-recognition"];

beforeEach(() => {
  registry.check.mockReset();
  registry.request.mockReset();
  registry.check.mockResolvedValue({
    status: "not-determined",
    canRequest: true,
  });
});

describe("usePermissionPriming with walkthrough memory", () => {
  it("records a shown prompt and never fires it again after a restart", async () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "reopen", () => store);
    registry.request.mockResolvedValue({ status: "denied", canRequest: true });
    const first = renderHook(() => usePermissionPriming(ids, { memory }));
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(() => first.result.current.request("speech-recognition"));
    expect(registry.request).toHaveBeenCalledTimes(1);
    expect(memory.read().attempted).toEqual({ speechrecognition: true });
    const denied = first.result.current.items.find(
      (item) => item.id === "speech-recognition",
    );
    expect(denied).toMatchObject({ canRequest: false, promptShown: true });
    first.unmount();

    // Restart: the OS may report "prompt" again, but the walkthrough already asked.
    const second = renderHook(() => usePermissionPriming(ids, { memory }));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    const resumed = second.result.current.items.find(
      (item) => item.id === "speech-recognition",
    );
    expect(resumed).toMatchObject({ canRequest: false, promptShown: true });
    await act(() => second.result.current.request("speech-recognition"));
    expect(registry.request).toHaveBeenCalledTimes(1);
    // An untouched step still prompts on its tap.
    registry.request.mockResolvedValue({
      status: "granted",
      canRequest: false,
    });
    await act(() => second.result.current.request("microphone"));
    expect(registry.request).toHaveBeenCalledTimes(2);
    expect(second.result.current.items[0]).toMatchObject({
      resolved: true,
      promptShown: false,
    });
  });

  it("keeps retry open when the request fails before the OS answers", async () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "reopen", () => store);
    registry.request.mockRejectedValueOnce(new Error("bridge"));
    const hook = renderHook(() =>
      usePermissionPriming(["microphone"], { memory }),
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(() => hook.result.current.request("microphone"));
    expect(memory.read().attempted).toEqual({});
    expect(hook.result.current.items[0]).toMatchObject({
      requestError: true,
      canRequest: true,
    });
  });

  it("remembers Skip for now and, without memory, keeps the old retry behaviour", async () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "reopen", () => store);
    const hook = renderHook(() =>
      usePermissionPriming(["microphone"], { memory }),
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    act(() => hook.result.current.skipAll());
    expect(memory.read().dismissed).toBe(true);
    expect(hook.result.current.done).toBe(true);

    registry.request.mockResolvedValue({ status: "denied", canRequest: true });
    const plain = renderHook(() => usePermissionPriming(["microphone"]));
    await waitFor(() => expect(plain.result.current.ready).toBe(true));
    await act(() => plain.result.current.request("microphone"));
    await act(() => plain.result.current.request("microphone"));
    expect(registry.request).toHaveBeenCalledTimes(2);
    expect(plain.result.current.items[0]).toMatchObject({
      canRequest: true,
      promptShown: false,
    });
  });
});
