// @vitest-environment jsdom

// Connection-loss recovery UI: the reconnecting/failed top banner
// (ConnectionFailedBanner), the exhausted-attempts modal (ConnectionLostOverlay),
// and the shared→dedicated cloud handoff toast (CloudHandoffBanner).
//
// These banners read their state from the real `useAppSelector` external store
// (driven here via __setAppValueForTests) and from the real lifecycle reducer
// (useLifecycleState). The only mocked collaborators are the transport-facing
// callbacks (retry/relaunch) and the desktop-runtime probe.

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ConnectionLostOverlay branches on the desktop runtime: force the electrobun
// path so "Restart" calls the (mockable) relaunchDesktop instead of jsdom's
// unimplemented window.location.reload.
vi.mock("../../bridge", () => ({
  isElectrobunRuntime: () => true,
}));

import type { AppContextValue } from "../../state/internal";
import { __setAppValueForTests } from "../../state/app-store";
import { useLifecycleState } from "../../state/useLifecycleState";
import {
  CLOUD_HANDOFF_RETRY_EVENT,
  type CloudHandoffRetryDetail,
  dispatchCloudHandoffPhase,
} from "../../events";
import { CloudHandoffBanner } from "./CloudHandoffBanner";
import { ConnectionFailedBanner } from "./ConnectionFailedBanner";
import { ConnectionLostOverlay } from "./ConnectionLostOverlay";

type BackendConnection = AppContextValue["backendConnection"];

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

function connection(partial: Partial<BackendConnection>): BackendConnection {
  return {
    state: "disconnected",
    reconnectAttempt: 0,
    maxReconnectAttempts: 15,
    showDisconnectedUI: false,
    ...partial,
  } as BackendConnection;
}

interface SeedOverrides {
  backendConnection: BackendConnection;
  backendDisconnectedBannerDismissed?: boolean;
  dismissBackendDisconnectedBanner?: () => void;
  retryBackendConnection?: () => void;
  relaunchDesktop?: () => Promise<void>;
}

function seed(overrides: SeedOverrides): void {
  const value = {
    t,
    backendDisconnectedBannerDismissed: false,
    dismissBackendDisconnectedBanner: () => {},
    retryBackendConnection: () => {},
    relaunchDesktop: async () => {},
    ...overrides,
  } as unknown as AppContextValue;
  act(() => {
    __setAppValueForTests(value);
  });
}

afterEach(() => {
  cleanup();
  act(() => {
    __setAppValueForTests(null);
  });
  vi.clearAllMocks();
});

describe("ConnectionFailedBanner — loss/recovery signal", () => {
  it("shows the reconnecting banner with the live attempt counter on a loss signal", () => {
    seed({
      backendConnection: connection({
        state: "reconnecting",
        reconnectAttempt: 3,
        maxReconnectAttempts: 15,
      }),
    });
    const { container } = render(<ConnectionFailedBanner />);

    const banner = container.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    // Attempt/limit are rendered from the connection state, not hardcoded.
    expect(banner?.textContent).toContain("3/15");
    expect(banner?.getAttribute("aria-live")).toBe("polite");
    // No failed-state action buttons while merely reconnecting.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reflects a later attempt number when the reconnect state advances", () => {
    seed({
      backendConnection: connection({ state: "reconnecting", reconnectAttempt: 3 }),
    });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "3/15",
    );

    seed({
      backendConnection: connection({ state: "reconnecting", reconnectAttempt: 9 }),
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("9/15");
    expect(status?.textContent).not.toContain("3/15");
  });

  it("shows the failed alert with dismiss + retry once attempts are exhausted", () => {
    seed({
      backendConnection: connection({ state: "failed" }),
      backendDisconnectedBannerDismissed: false,
    });
    const { container } = render(<ConnectionFailedBanner />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    // Both recovery affordances are present.
    expect(screen.getByText("common.dismiss")).toBeTruthy();
    expect(screen.getByText("vectorbrowserview.RetryConnection")).toBeTruthy();
  });

  it("hides on recovery — a connected signal renders nothing", () => {
    seed({ backendConnection: connection({ state: "reconnecting", reconnectAttempt: 4 }) });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    seed({ backendConnection: connection({ state: "connected" }) });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("yields to the full-screen overlay: renders nothing when showDisconnectedUI is set", () => {
    // Even though state is failed, the modal owns the surface — the in-flow
    // banner must step aside so both do not stack.
    seed({
      backendConnection: connection({ state: "failed", showDisconnectedUI: true }),
    });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("dismiss button invokes the dismiss handler exactly once", () => {
    const dismiss = vi.fn();
    seed({
      backendConnection: connection({ state: "failed" }),
      dismissBackendDisconnectedBanner: dismiss,
    });
    render(<ConnectionFailedBanner />);

    fireEvent.click(screen.getByText("common.dismiss"));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not render the failed alert once dismissed (latch consumed by store flag)", () => {
    seed({
      backendConnection: connection({ state: "failed" }),
      backendDisconnectedBannerDismissed: true,
    });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("retry button forwards to retryBackendConnection", () => {
    const retry = vi.fn();
    seed({
      backendConnection: connection({ state: "failed" }),
      retryBackendConnection: retry,
    });
    render(<ConnectionFailedBanner />);

    fireEvent.click(screen.getByText("vectorbrowserview.RetryConnection"));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionLostOverlay — exhausted-attempts modal", () => {
  it("renders only when failed AND showDisconnectedUI is set", () => {
    seed({ backendConnection: connection({ state: "failed", showDisconnectedUI: false }) });
    const { container, rerender } = render(<ConnectionLostOverlay />);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();

    seed({ backendConnection: connection({ state: "failed", showDisconnectedUI: true }) });
    rerender(<ConnectionLostOverlay />);
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("hides when the connection recovers (state leaves failed)", () => {
    seed({ backendConnection: connection({ state: "failed", showDisconnectedUI: true }) });
    const { container } = render(<ConnectionLostOverlay />);
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    seed({ backendConnection: connection({ state: "reconnecting", showDisconnectedUI: false }) });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("single-flight restart: mashing Restart fires relaunchDesktop exactly once", () => {
    // A never-resolving relaunch keeps `busy` latched so the in-component guard
    // (`if (busy) return`) + disabled attr prevent concurrent reconnects.
    const relaunch = vi.fn(() => new Promise<void>(() => {}));
    seed({
      backendConnection: connection({ state: "failed", showDisconnectedUI: true }),
      relaunchDesktop: relaunch,
    });
    render(<ConnectionLostOverlay />);

    // Desktop runtime → defaultValue "Restart App" (see t()).
    const restart = screen.getByText("Restart App").closest("button");
    expect(restart).not.toBeNull();
    if (!restart) throw new Error("restart button missing");

    fireEvent.click(restart);
    fireEvent.click(restart);
    fireEvent.click(restart);
    fireEvent.click(restart);

    expect(relaunch).toHaveBeenCalledTimes(1);
    // Both actions are disabled while the restart is in flight.
    expect(restart.getAttribute("disabled")).not.toBeNull();
    const retry = screen.getByText("Retry Connection").closest("button");
    expect(retry?.getAttribute("disabled")).not.toBeNull();
  });

  it("retry button forwards to retryBackendConnection", () => {
    const retry = vi.fn();
    seed({
      backendConnection: connection({ state: "failed", showDisconnectedUI: true }),
      retryBackendConnection: retry,
    });
    render(<ConnectionLostOverlay />);

    // Overlay passes a defaultValue, so the rendered label is "Retry Connection".
    fireEvent.click(screen.getByText("Retry Connection"));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("dismiss-latch semantics through the real lifecycle reducer + banner", () => {
  function bindStore(hook: ReturnType<typeof useLifecycleState>) {
    seed({
      backendConnection: hook.state.backendConnection,
      backendDisconnectedBannerDismissed: hook.state.backendDisconnectedBannerDismissed,
      dismissBackendDisconnectedBanner: hook.dismissBackendBanner,
    });
  }

  it("dismiss stays dismissed across repeated failed updates, but a new distinct loss re-arms it", () => {
    const { result } = renderHook(() => useLifecycleState());
    const { container } = render(<ConnectionFailedBanner />);

    // 1) Loss → failed: the alert shows.
    act(() => result.current.setBackendConnection({ state: "failed" }));
    bindStore(result.current);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    // 2) User dismisses.
    act(() => result.current.dismissBackendBanner());
    bindStore(result.current);
    expect(result.current.state.backendDisconnectedBannerDismissed).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // 3) Another failed update (e.g. attempt bump) MUST NOT resurrect the banner:
    //    the reducer preserves the dismissed latch while state stays failed.
    act(() =>
      result.current.setBackendConnection({ state: "failed", reconnectAttempt: 15 }),
    );
    bindStore(result.current);
    expect(result.current.state.backendDisconnectedBannerDismissed).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // 4) A distinct new loss cycle (reconnecting) clears the latch → banner returns.
    act(() =>
      result.current.setBackendConnection({ state: "reconnecting", reconnectAttempt: 1 }),
    );
    bindStore(result.current);
    expect(result.current.state.backendDisconnectedBannerDismissed).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("1/15");
  });

  it("recovery (connected) clears the dismiss latch", () => {
    const { result } = renderHook(() => useLifecycleState());
    act(() => result.current.setBackendConnection({ state: "failed" }));
    act(() => result.current.dismissBackendBanner());
    expect(result.current.state.backendDisconnectedBannerDismissed).toBe(true);

    act(() => result.current.setBackendConnection({ state: "connected" }));
    expect(result.current.state.backendDisconnectedBannerDismissed).toBe(false);
  });

  it("is idempotent under rapid loss/recover toggling", () => {
    const { result } = renderHook(() => useLifecycleState());

    for (let i = 0; i < 6; i++) {
      act(() =>
        result.current.setBackendConnection({
          state: "reconnecting",
          reconnectAttempt: i + 1,
        }),
      );
      act(() => result.current.setBackendConnection({ state: "failed" }));
      act(() => result.current.dismissBackendBanner());
      act(() => result.current.setBackendConnection({ state: "connected" }));
    }

    // After a full recover on each cycle the latch is clear and the connection
    // is settled — no accumulated state from the toggling.
    expect(result.current.state.backendConnection.state).toBe("connected");
    expect(result.current.state.backendDisconnectedBannerDismissed).toBe(false);

    // resetBackendConnection returns to the pristine disconnected baseline.
    act(() => result.current.resetBackendConnection());
    expect(result.current.state.backendConnection.state).toBe("disconnected");
    expect(result.current.state.backendConnection.reconnectAttempt).toBe(0);
    expect(result.current.state.backendConnection.showDisconnectedUI).toBe(false);
  });
});

describe("CloudHandoffBanner — shared→dedicated handoff toast", () => {
  it("renders the migrating message on a migrating phase and offers no retry", () => {
    const { container } = render(<CloudHandoffBanner />);
    // Nothing before a phase is emitted.
    expect(container.querySelector('[role="status"]')).toBeNull();

    act(() =>
      dispatchCloudHandoffPhase({ agentId: "agent-1", phase: "migrating" }),
    );
    const toast = container.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain("Setting up your dedicated agent");
    // In-flight: no retry affordance.
    expect(screen.queryByTestId("cloud-handoff-retry")).toBeNull();
  });

  it("renders the failure message with a Retry that dispatches the retry event for the same agent", () => {
    const retries: CloudHandoffRetryDetail[] = [];
    const onRetry = (e: Event) =>
      retries.push((e as CustomEvent<CloudHandoffRetryDetail>).detail);
    window.addEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);

    try {
      const { container } = render(<CloudHandoffBanner />);
      act(() =>
        dispatchCloudHandoffPhase({ agentId: "agent-42", phase: "failed" }),
      );
      expect(container.textContent).toContain(
        "Couldn't switch to your dedicated agent",
      );

      const retryBtn = screen.getByTestId("cloud-handoff-retry");
      act(() => {
        fireEvent.click(retryBtn);
      });

      // The retry re-invokes the (idempotent) supervisor for the SAME agent —
      // the payload round-trips the agentId from the failed phase.
      expect(retries).toHaveLength(1);
      expect(retries[0]).toEqual({ agentId: "agent-42" });
    } finally {
      window.removeEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
    }
  });

  it("shows the success message and no retry once switched", () => {
    const { container } = render(<CloudHandoffBanner />);
    act(() =>
      dispatchCloudHandoffPhase({ agentId: "agent-1", phase: "switched" }),
    );
    expect(container.textContent).toContain("You're now on your dedicated agent");
    expect(screen.queryByTestId("cloud-handoff-retry")).toBeNull();
  });
});
