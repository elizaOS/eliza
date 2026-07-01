// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import { StreamView } from "./StreamView";

// StreamView's only real data seam is the `client` singleton (`../../api/client`),
// which exposes streamStatus() / streamGoLive() / streamGoOffline() over HTTP.
// We mock exactly that boundary and drive every state transition through the
// real component + real StatusBar so we assert semantic outcomes: the exact
// call each control fires, the live/offline/unavailable/error panels, the
// popout side-effect, cache writes, the go-live failure-recovery re-poll, and
// the loadingRef double-click idempotency guard.
const clientMock = vi.hoisted(() => ({
  streamStatus: vi.fn(),
  streamGoLive: vi.fn(),
  streamGoOffline: vi.fn(),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));

// openStreamPopout is a window.open collaborator shared by StreamView (auto-open
// on go-live) and StatusBar (the pop-out button). Mock it so we can assert the
// exact apiBase payload without touching real window management.
const openStreamPopout = vi.hoisted(() => vi.fn(() => null as Window | null));
vi.mock("../stream/popout-url", () => ({ openStreamPopout }));

// Runtime/boot collaborators: keep them stable + non-electrobun so the auto
// go-live popout branch (`result.live && !IS_POPOUT && !isElectrobun`) is live.
vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));
vi.mock("../../config/boot-config", () => ({
  getBootConfig: () => ({
    branding: { appName: "Eliza" },
    apiBase: "http://api.test",
  }),
}));

// resource-cache: start cold (getCached → null so initialLoading is true) and
// spy on setCached to prove a successful poll persists the snapshot.
const cacheStore = vi.hoisted(() => ({ getCached: vi.fn(), setCached: vi.fn() }));
vi.mock("../../hooks/resource-cache", () => ({
  getCached: cacheStore.getCached,
  setCached: cacheStore.setCached,
}));

// Silence the 5s visibility poll so call counts are driven solely by the
// mount read + explicit control clicks (deterministic assertions).
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useDocumentVisibility: () => true,
  useIntervalWhenDocumentVisible: () => {},
}));

// Pure agent-surface wrapper — render children only.
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// Passthrough translator + a stable agentStatus off the store.
const LABELS: Record<string, string> = {
  "statusbar.LiveShort": "LIVE",
  "statusbar.OfflineShort": "OFFLINE",
  "statusbar.GoLive": "Go Live",
  "statusbar.StopStream": "Stop Stream",
  "streamview.StreamingUnavailabl": "Streaming unavailable",
  "streamview.StreamIsLive": "Stream is Live",
  "streamview.StreamReady": "Stream Ready",
};
function t(key: string, options?: { defaultValue?: string }): string {
  return LABELS[key] ?? options?.defaultValue ?? key;
}
vi.mock("../../state", () => ({
  useAppSelector: (sel: (s: { t: typeof t; agentStatus: unknown }) => unknown) =>
    sel({ t, agentStatus: { agentName: "TestAgent" } }),
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Status = Awaited<ReturnType<typeof clientMock.streamStatus>>;
function status(overrides: Partial<Status> = {}): Status {
  return {
    ok: true,
    running: false,
    ffmpegAlive: false,
    uptime: 0,
    frameCount: 0,
    volume: 1,
    muted: false,
    audioSource: "mic",
    inputMode: null,
    destination: null,
    ...overrides,
  } as Status;
}

function notFound(): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/stream/status",
    message: "Not Found",
    status: 404,
  });
}

function toggleButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /Go Live|Stop Stream|\.\.\./.test(b.textContent ?? ""),
  );
  if (!btn) throw new Error("toggle button not found");
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.getCached.mockReturnValue(null);
  clientMock.streamGoLive.mockResolvedValue({ ok: true, live: true });
  clientMock.streamGoOffline.mockResolvedValue({ ok: true, live: false });
});

afterEach(() => cleanup());

describe("StreamView", () => {
  it("reads status once on mount and paints the offline 'Stream Ready' panel", async () => {
    clientMock.streamStatus.mockResolvedValue(status({ running: false }));
    render(<StreamView />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream Ready"),
    );
    expect(clientMock.streamStatus).toHaveBeenCalledTimes(1);
    // Offline → OFFLINE badge + enabled Go Live control, no live health stats.
    expect(document.body.textContent).toContain("OFFLINE");
    expect(toggleButton().textContent).toContain("Go Live");
    expect(toggleButton().disabled).toBe(false);
    // Successful poll persists the snapshot for instant repaint on revisit.
    expect(cacheStore.setCached).toHaveBeenCalledWith(
      "stream:status",
      expect.objectContaining({ running: false }),
    );
  });

  it("shows the skeleton while the first status read is in flight (no live/ready flash)", async () => {
    const d = deferred<Status>();
    clientMock.streamStatus.mockReturnValue(d.promise);
    render(<StreamView />);

    // initialLoading + available + no error → neither panel heading is shown.
    expect(document.body.textContent).not.toContain("Stream Ready");
    expect(document.body.textContent).not.toContain("Stream is Live");
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull();

    await act(async () => {
      d.resolve(status({ running: true, ffmpegAlive: true }));
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream is Live"),
    );
  });

  it("renders the live panel with real uptime + frame count when running", async () => {
    clientMock.streamStatus.mockResolvedValue(
      status({ running: true, ffmpegAlive: true, uptime: 65, frameCount: 1234 }),
    );
    render(<StreamView />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream is Live"),
    );
    expect(document.body.textContent).toContain("LIVE");
    // StatusBar renders the locale-formatted frame count from the DTO.
    expect(document.body.textContent).toContain("1,234f");
    expect(toggleButton().textContent).toContain("Stop Stream");
  });

  it("running but ffmpeg dead is treated as NOT live (both flags required)", async () => {
    clientMock.streamStatus.mockResolvedValue(
      status({ running: true, ffmpegAlive: false }),
    );
    render(<StreamView />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream Ready"),
    );
    expect(document.body.textContent).not.toContain("Stream is Live");
  });

  it("Go Live fires streamGoLive and auto-opens the popout with the apiBase", async () => {
    clientMock.streamStatus.mockResolvedValue(status({ running: false }));
    clientMock.streamGoLive.mockResolvedValue({ ok: true, live: true });
    render(<StreamView />);
    await waitFor(() => expect(toggleButton().textContent).toContain("Go Live"));

    await act(async () => {
      fireEvent.click(toggleButton());
    });

    expect(clientMock.streamGoLive).toHaveBeenCalledTimes(1);
    expect(clientMock.streamGoOffline).not.toHaveBeenCalled();
    expect(openStreamPopout).toHaveBeenCalledWith("http://api.test");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream is Live"),
    );
  });

  it("Stop Stream fires streamGoOffline and does NOT open a popout", async () => {
    clientMock.streamStatus.mockResolvedValue(
      status({ running: true, ffmpegAlive: true }),
    );
    render(<StreamView />);
    await waitFor(() =>
      expect(toggleButton().textContent).toContain("Stop Stream"),
    );

    await act(async () => {
      fireEvent.click(toggleButton());
    });

    expect(clientMock.streamGoOffline).toHaveBeenCalledTimes(1);
    expect(clientMock.streamGoLive).not.toHaveBeenCalled();
    expect(openStreamPopout).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream Ready"),
    );
  });

  it("does not auto-open the popout when go-live reports live:false", async () => {
    clientMock.streamStatus.mockResolvedValue(status({ running: false }));
    clientMock.streamGoLive.mockResolvedValue({ ok: true, live: false });
    render(<StreamView />);
    await waitFor(() => expect(toggleButton().textContent).toContain("Go Live"));

    await act(async () => {
      fireEvent.click(toggleButton());
    });

    expect(clientMock.streamGoLive).toHaveBeenCalledTimes(1);
    expect(openStreamPopout).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Stream is Live");
  });

  it("rapid double-click go-live fires exactly one request (loadingRef idempotency)", async () => {
    clientMock.streamStatus.mockResolvedValue(status({ running: false }));
    const d = deferred<{ ok: boolean; live: boolean }>();
    clientMock.streamGoLive.mockReturnValue(d.promise);
    render(<StreamView />);
    await waitFor(() => expect(toggleButton().textContent).toContain("Go Live"));

    // Two synchronous clicks while the first request is still in flight.
    await act(async () => {
      const btn = toggleButton();
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(clientMock.streamGoLive).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ ok: true, live: true });
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream is Live"),
    );
  });

  it("a 404 status read switches to the 'streaming unavailable' panel with a disabled control", async () => {
    clientMock.streamStatus.mockRejectedValue(notFound());
    render(<StreamView />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Streaming unavailable"),
    );
    // Unavailable → control disabled, no toggle possible, nothing cached.
    expect(toggleButton().disabled).toBe(true);
    expect(cacheStore.setCached).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Stream Ready");
  });

  it("a non-404 status error surfaces an alert instead of masquerading as idle", async () => {
    clientMock.streamStatus.mockRejectedValue(new Error("status endpoint boom"));
    render(<StreamView />);

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("status endpoint boom");
    });
    // A broken status endpoint must NOT render the healthy "Stream Ready" idle panel.
    expect(document.body.textContent).not.toContain("Stream Ready");
    // Still "available" (not a 404) → control stays enabled for a retry.
    expect(toggleButton().disabled).toBe(false);
  });

  it("go-live failure re-polls status and reflects the recovered live state", async () => {
    clientMock.streamStatus
      .mockResolvedValueOnce(status({ running: false }))
      .mockResolvedValueOnce(status({ running: true, ffmpegAlive: true }));
    clientMock.streamGoLive.mockRejectedValue(new Error("go-live failed"));
    render(<StreamView />);
    await waitFor(() => expect(toggleButton().textContent).toContain("Go Live"));

    await act(async () => {
      fireEvent.click(toggleButton());
    });

    expect(clientMock.streamGoLive).toHaveBeenCalledTimes(1);
    // catch-branch re-reads status; the backend actually went live, so the
    // live flag recovers even though the go-live request threw.
    expect(clientMock.streamStatus).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Stream is Live"),
    );
    expect(document.body.textContent).toContain("LIVE");
  });
});
