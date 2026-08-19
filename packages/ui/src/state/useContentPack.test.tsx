/**
 * Verifies that URL content-pack loads own their lifecycle: a replacement
 * aborts the prior request and unmount aborts the remaining request.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadFromUrl: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("../content-packs", () => ({
  applyColorScheme: vi.fn(() => () => undefined),
  applyContentPack: vi.fn(),
  loadContentPackFromFiles: vi.fn(),
  loadContentPackFromUrl: mocks.loadFromUrl,
  releaseLoadedContentPack: vi.fn(),
}));

vi.mock("./app-store", () => ({
  useAppSelectorShallow: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
    selector({
      setState: mocks.setState,
      activePackId: null,
      selectedVrmIndex: 0,
      customVrmUrl: "",
      customVrmPreviewUrl: "",
      customBackgroundUrl: "",
      customWorldUrl: "",
      firstRunName: "",
      firstRunStyle: "",
    }),
}));

vi.mock("./persistence", () => ({
  loadPersistedActivePackUrl: vi.fn(() => null),
  savePersistedActivePackUrl: vi.fn(),
}));

import { useContentPack } from "./useContentPack";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useContentPack URL request lifecycle", () => {
  it("aborts superseded and unmounted URL loads without surfacing errors", async () => {
    const signals: AbortSignal[] = [];
    mocks.loadFromUrl.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    );
    const view = renderHook(() => useContentPack());

    let first!: Promise<void>;
    act(() => {
      first = view.result.current.loadFromUrl("https://example.com/first");
    });
    await waitFor(() => expect(signals).toHaveLength(1));

    let second!: Promise<void>;
    act(() => {
      second = view.result.current.loadFromUrl("https://example.com/second");
    });
    await first;
    expect(signals[0]?.aborted).toBe(true);
    expect(view.result.current.error).toBeNull();

    view.unmount();
    await second;
    expect(signals[1]?.aborted).toBe(true);
  });
});
