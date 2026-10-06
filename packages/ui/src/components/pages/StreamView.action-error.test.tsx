/**
 * Verifies that a rejected Go Live / Stop Stream mutation on the Stream view
 * becomes a visible alert instead of silently restoring the idle state. The
 * real StreamView (including its toggle handler and reconciling status read)
 * renders in jsdom; only the API client, the shell wrapper, and the shared
 * resource cache are harness-driven.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientHarness = vi.hoisted(() => ({
  streamStatus: vi.fn(),
  streamGoLive: vi.fn(),
  streamGoOffline: vi.fn(),
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));

vi.mock("../../hooks/resource-cache", () => ({
  getCached: () => undefined,
  setCached: vi.fn(),
}));

vi.mock("../stream/popout-url", () => ({
  openStreamPopout: vi.fn(),
}));

vi.mock("../../state/app-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/app-store")>();
  const state = {
    agentStatus: null,
    t: (
      _key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : _key,
  };
  return {
    ...actual,
    useAppSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAppSelectorShallow: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    client: {
      getBaseUrl: () => "http://localhost:3000",
      streamStatus: clientHarness.streamStatus,
      streamGoLive: clientHarness.streamGoLive,
      streamGoOffline: clientHarness.streamGoOffline,
    },
  };
});

import { StreamView } from "./StreamView";

function idleStatus() {
  return { running: false, ffmpegAlive: true, uptime: 0, frameCount: 0 };
}

describe("StreamView action errors", () => {
  beforeEach(() => {
    clientHarness.streamStatus.mockReset();
    clientHarness.streamGoLive.mockReset();
    clientHarness.streamGoOffline.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("surfaces a rejected Go Live through the alert panel and reconciles status", async () => {
    clientHarness.streamStatus.mockResolvedValue(idleStatus());
    clientHarness.streamGoLive.mockRejectedValue(new Error("Encoder refused"));

    render(<StreamView />);
    await screen.findByText("Stream Ready");

    fireEvent.click(screen.getByRole("button", { name: "Go Live" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Encoder refused")).toBeTruthy();
    // The handler reconciles against authoritative status instead of
    // fabricating the resulting stream state.
    expect(clientHarness.streamStatus.mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );
    // The reconciled authoritative state stays idle while the alert shows.
    expect(screen.getByText("OFFLINE")).toBeTruthy();
    const goLive = screen.getByRole("button", {
      name: "Go Live",
    }) as HTMLButtonElement;
    expect(goLive.disabled).toBe(false);
  });

  it("surfaces a rejected Stop Stream through the alert panel", async () => {
    clientHarness.streamStatus.mockResolvedValue({
      running: true,
      ffmpegAlive: true,
      uptime: 12,
      frameCount: 34,
    });
    clientHarness.streamGoOffline.mockRejectedValue(
      new Error("RTMP ingest refused"),
    );

    render(<StreamView />);
    await screen.findByText("Stream is Live");

    fireEvent.click(screen.getByRole("button", { name: "Stop Stream" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("RTMP ingest refused")).toBeTruthy();
  });
});
