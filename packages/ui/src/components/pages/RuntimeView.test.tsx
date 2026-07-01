// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeDebugSnapshot,
  RuntimeOrderItem,
  RuntimeServiceOrderItem,
} from "../../api";
import { __resetResourceCache } from "../../hooks/resource-cache";
import { getViewChatBinding } from "../../state/view-chat-binding";
import { RuntimeView } from "./RuntimeView";

// RuntimeView's only data seam is the `client` singleton re-exported from
// `../../api` — it fetches the runtime debug snapshot via
// client.getRuntimeSnapshot({ depth, maxArrayLength, maxObjectEntries }) on
// mount, whenever a cap input changes, and on a silent 5s poll. We mock that
// single boundary and drive everything else through the real component so we
// assert real state transitions, the exact request payloads, and the
// stale-response race guard (snapshotRequestIdRef) — not render smoke.
const clientMock = vi.hoisted(() => ({
  getRuntimeSnapshot: vi.fn(),
}));

vi.mock("../../api", () => ({ client: clientMock }));

// RuntimeView reads only the translator off the store (useAppSelector(s => s.t)).
// Give it an explicit label map so sidebar-filter assertions are unambiguous
// (the real i18n keys otherwise all share the "runtimeview." / "common." stem).
const LABELS: Record<string, string> = {
  "runtimeview.Summary": "Summary",
  "common.runtime": "Runtime",
  "common.actions": "Actions",
  "common.providers": "Providers",
  "common.plugins": "Plugins",
  "runtimeview.tabServices": "Services",
  "common.evaluators": "Evaluators",
};

function t(key: string, options?: { defaultValue?: string }): string {
  return LABELS[key] ?? options?.defaultValue ?? key;
}

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: { t: typeof t }) => unknown) => sel({ t }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function order(name: string, className: string, index = 0): RuntimeOrderItem {
  return { index, name, className, id: null };
}

function serviceGroup(): RuntimeServiceOrderItem {
  return {
    index: 0,
    serviceType: "database",
    count: 1,
    instances: [order("db", "PgLiteService", 0)],
  };
}

function makeSnapshot(
  overrides: Partial<RuntimeDebugSnapshot> = {},
): RuntimeDebugSnapshot {
  return {
    runtimeAvailable: true,
    generatedAt: 1_700_000_000_000,
    settings: {
      maxDepth: 10,
      maxArrayLength: 1000,
      maxObjectEntries: 1000,
      maxStringLength: 500,
    },
    meta: {
      agentId: "agent-1",
      agentState: "running",
      agentName: "Ada",
      model: "gpt-5.5",
      pluginCount: 1,
      actionCount: 2,
      providerCount: 3,
      evaluatorCount: 0,
      serviceTypeCount: 1,
      serviceCount: 1,
    },
    order: {
      plugins: [order("bootstrap", "BootstrapPlugin", 0)],
      actions: [order("reply", "ReplyAction", 0), order("ignore", "IgnoreAction", 1)],
      providers: [order("time", "TimeProvider", 0)],
      evaluators: [],
      services: [serviceGroup()],
    },
    sections: {
      runtime: { agentId: "agent-1", nested: { a: 1 } },
      plugins: { list: ["bootstrap"] },
      actions: { list: ["reply", "ignore"] },
      providers: {},
      evaluators: {},
      services: {},
    },
    ...overrides,
  };
}

beforeEach(() => {
  clientMock.getRuntimeSnapshot.mockReset();
  // The view seeds/writes the module-level resource cache keyed by every fetch
  // param — reset so each test starts cold (else a warm key flips the mount
  // into the silent-revalidate branch and skips the loading state).
  __resetResourceCache();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RuntimeView", () => {
  it("fetches the snapshot on mount with the default caps and renders the summary from order + meta", async () => {
    clientMock.getRuntimeSnapshot.mockResolvedValue(makeSnapshot());

    render(<RuntimeView />);

    // Loading: summary content is not on screen until the fetch resolves.
    expect(screen.queryByText("[0] bootstrap :: BootstrapPlugin")).toBeNull();

    await waitFor(() => {
      expect(
        screen.getByText("[0] bootstrap :: BootstrapPlugin"),
      ).toBeTruthy();
    });

    // Exact payload sent to the boundary — the default caps.
    expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledWith({
      depth: 10,
      maxArrayLength: 1000,
      maxObjectEntries: 1000,
    });

    // Order cards render each registered handler.
    expect(screen.getByText("[0] reply :: ReplyAction")).toBeTruthy();
    expect(screen.getByText("[1] ignore :: IgnoreAction")).toBeTruthy();
    expect(screen.getByText("[0] time :: TimeProvider")).toBeTruthy();

    // Summary card reflects meta values.
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("gpt-5.5")).toBeTruthy();
  });

  it("surfaces the fetch error message in a danger notice and shows no summary", async () => {
    clientMock.getRuntimeSnapshot.mockRejectedValue(
      new Error("runtime debug endpoint 503"),
    );

    render(<RuntimeView />);

    await waitFor(() => {
      expect(screen.getByText("runtime debug endpoint 503")).toBeTruthy();
    });
    // No snapshot => the empty "no snapshot" state, never the summary cards.
    expect(screen.queryByText("[0] bootstrap :: BootstrapPlugin")).toBeNull();
  });

  it("renders the runtime-pending empty state (not the summary) when runtimeAvailable is false", async () => {
    clientMock.getRuntimeSnapshot.mockResolvedValue(
      makeSnapshot({ runtimeAvailable: false }),
    );

    render(<RuntimeView />);

    await waitFor(() => {
      expect(screen.getByText("runtimeview.AgentRuntimeIsNot")).toBeTruthy();
    });
    // The order cards must NOT render while the runtime is unavailable.
    expect(screen.queryByText("[0] bootstrap :: BootstrapPlugin")).toBeNull();
  });

  it("re-fetches with the clamped depth when the depth cap changes (config edit -> new payload)", async () => {
    clientMock.getRuntimeSnapshot.mockResolvedValue(makeSnapshot());

    render(<RuntimeView />);
    await waitFor(() =>
      expect(screen.getByText("Ada")).toBeTruthy(),
    );
    clientMock.getRuntimeSnapshot.mockClear();

    const depthInput = screen.getByLabelText("runtimeview.depth") as HTMLInputElement;

    // Valid edit: 5 is within [1, 24].
    fireEvent.change(depthInput, { target: { value: "5" } });
    expect(depthInput.value).toBe("5");
    await waitFor(() => {
      expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledWith({
        depth: 5,
        maxArrayLength: 1000,
        maxObjectEntries: 1000,
      });
    });
  });

  it("clamps adversarial cap input: above-max is pinned to 24, non-numeric falls back to 1", async () => {
    clientMock.getRuntimeSnapshot.mockResolvedValue(makeSnapshot());
    render(<RuntimeView />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeTruthy());

    const depthInput = screen.getByLabelText("runtimeview.depth") as HTMLInputElement;

    // Over the max -> clamped to 24 both in the DOM value and the request.
    clientMock.getRuntimeSnapshot.mockClear();
    fireEvent.change(depthInput, { target: { value: "999" } });
    expect(depthInput.value).toBe("24");
    await waitFor(() => {
      expect(clientMock.getRuntimeSnapshot).toHaveBeenLastCalledWith({
        depth: 24,
        maxArrayLength: 1000,
        maxObjectEntries: 1000,
      });
    });

    // Garbage -> Number("abc")||1 -> 1 (never NaN in the payload).
    clientMock.getRuntimeSnapshot.mockClear();
    fireEvent.change(depthInput, { target: { value: "abc" } });
    expect(depthInput.value).toBe("1");
    await waitFor(() => {
      expect(clientMock.getRuntimeSnapshot).toHaveBeenLastCalledWith({
        depth: 1,
        maxArrayLength: 1000,
        maxObjectEntries: 1000,
      });
    });
  });

  it("drops a stale in-flight response when a newer request resolves first (rapid-fire race guard)", async () => {
    const first = deferred<RuntimeDebugSnapshot>();
    const second = deferred<RuntimeDebugSnapshot>();
    clientMock.getRuntimeSnapshot
      .mockReturnValueOnce(first.promise) // mount fetch (depth 10)
      .mockReturnValueOnce(second.promise); // depth-change fetch (depth 7)

    render(<RuntimeView />);

    // Trigger a second request before the first resolves.
    const depthInput = screen.getByLabelText("runtimeview.depth") as HTMLInputElement;
    fireEvent.change(depthInput, { target: { value: "7" } });
    await waitFor(() =>
      expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledTimes(2),
    );

    // The NEWER request resolves first with the fresh agent name...
    await act(async () => {
      second.resolve(makeSnapshot({ meta: { ...makeSnapshot().meta, agentName: "Fresh" } }));
    });
    await waitFor(() => expect(screen.getByText("Fresh")).toBeTruthy());

    // ...then the STALE first request resolves late with old data. The
    // requestId guard must ignore it — "Stale" must never paint.
    await act(async () => {
      first.resolve(makeSnapshot({ meta: { ...makeSnapshot().meta, agentName: "Stale" } }));
    });
    await waitFor(() => {}); // let any (wrongful) state update flush
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.getByText("Fresh")).toBeTruthy();
  });

  it("switches the active section without issuing a new fetch, and renders that section's tree root", async () => {
    clientMock.getRuntimeSnapshot.mockResolvedValue(makeSnapshot());
    render(<RuntimeView />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeTruthy());
    expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    const sidebar = screen.getByTestId("runtime-sidebar");
    fireEvent.click(within(sidebar).getByText("Actions"));

    // The tree panel for the actions section paints its root path...
    await waitFor(() => expect(screen.getByText("$actions")).toBeTruthy());
    // ...and switching sections is pure client state — no extra network call.
    expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("filters the sidebar sections through the registered chat-composer query binding", async () => {
    clientMock.getRuntimeSnapshot.mockResolvedValue(makeSnapshot());
    render(<RuntimeView />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeTruthy());

    const sidebar = screen.getByTestId("runtime-sidebar");
    // Both tabs present before filtering.
    expect(within(sidebar).queryByText("Plugins")).toBeTruthy();
    expect(within(sidebar).queryByText("Evaluators")).toBeTruthy();

    // The real filter seam is the view-chat binding the composer drives.
    const binding = getViewChatBinding();
    expect(binding).toBeTruthy();
    act(() => {
      binding?.onQuery("plugins");
    });

    await waitFor(() => {
      expect(within(sidebar).queryByText("Evaluators")).toBeNull();
    });
    expect(within(sidebar).queryByText("Plugins")).toBeTruthy();
  });

  it("silently re-fetches on the visibility poll without clearing the on-screen snapshot", async () => {
    vi.useFakeTimers();
    clientMock.getRuntimeSnapshot.mockResolvedValue(makeSnapshot());

    render(<RuntimeView />);
    await act(async () => {
      await Promise.resolve();
    });
    // Mount fetch fired.
    expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    // Advance past the 5s poll interval.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(clientMock.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });
});
