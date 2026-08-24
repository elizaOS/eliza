// @vitest-environment jsdom
/**
 * Coverage for element-reporter.hooks: `buildPayload` snapshot-to-report
 * mapping against a real `ViewAgentRegistry`, and the subscribe/POST hook's
 * debounce, inertness, and cleanup behaviour. The registry and payload builder
 * are exercised for real; only the transport boundary (`fetchWithCsrf`) and
 * navigation/url helpers are mocked, and debounce timing uses fake timers.
 */
import { type RenderHookResult, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  buildPayload,
  useAgentSurfaceElementReporter,
} from "./element-reporter.hooks";
import { ViewAgentRegistry } from "./registry";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock("../navigation", () => ({
  getWindowNavigationPath: vi.fn(() => "/chat"),
}));

vi.mock("../utils/asset-url", () => ({
  resolveApiUrl: (path: string) => path,
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);

function makeRegistry(
  viewId = "wallet",
  viewType: "gui" | "tui" | "xr" = "gui",
): ViewAgentRegistry {
  return new ViewAgentRegistry(viewId, viewType);
}

describe("buildPayload", () => {
  it("passes view identity through and preserves registry order", () => {
    const registry = makeRegistry("wallet", "tui");
    const unregisterAmount = registry.register(
      {
        id: "amount",
        label: "Amount",
        role: "text-input",
        order: 20,
        getValue: () => "5",
      },
      () => null,
    );
    // Registered later but sorts first via the lower order key.
    registry.register(
      { id: "send", label: "Send", role: "button", order: 10 },
      () => null,
    );
    try {
      const payload = buildPayload(registry);
      expect(payload.viewId).toBe("wallet");
      expect(payload.viewType).toBe("tui");
      expect(payload.elements.map((e) => e.id)).toEqual(["send", "amount"]);
    } finally {
      unregisterAmount();
    }
  });

  it("includes string values and omits non-string values", () => {
    const registry = makeRegistry("form");
    registry.register(
      { id: "text", label: "Text", role: "text-input", getValue: () => "5" },
      () => null,
    );
    registry.register(
      {
        id: "check",
        label: "Check",
        role: "toggle",
        getValue: () => true,
      },
      () => null,
    );
    registry.register({ id: "bare", label: "Bare" }, () => null);

    const payload = buildPayload(registry);
    expect(payload.elements.map((e) => e.id)).toEqual([
      "text",
      "check",
      "bare",
    ]);
    expect(payload.elements[0]).toMatchObject({
      id: "text",
      role: "text-input",
      label: "Text",
      value: "5",
    });
    // A boolean DOM value is not a reportable string value.
    expect("value" in payload.elements[1]).toBe(false);
    expect("value" in payload.elements[2]).toBe(false);
  });

  it("reports focus only for the element that owns document focus", () => {
    const focusedInput = document.createElement("input");
    const idleInput = document.createElement("input");
    document.body.append(focusedInput, idleInput);
    focusedInput.focus();

    const registry = makeRegistry("composer");
    try {
      registry.register(
        {
          id: "focused",
          label: "Focused",
          role: "text-input",
          getValue: () => "typed",
        },
        () => focusedInput,
      );
      registry.register(
        { id: "idle", label: "Idle", role: "button" },
        () => idleInput,
      );

      const payload = buildPayload(registry);
      expect(payload.elements[0]).toMatchObject({
        id: "focused",
        value: "typed",
        focused: true,
      });
      expect("focused" in payload.elements[1]).toBe(false);
    } finally {
      focusedInput.remove();
      idleInput.remove();
    }
  });

  it("redacts values of sensitive elements even when they hold one", () => {
    const registry = makeRegistry("auth");
    registry.register(
      {
        id: "password",
        label: "Password",
        role: "text-input",
        sensitive: true,
        getValue: () => "secret-value",
      },
      () => null,
    );

    const payload = buildPayload(registry);
    expect(payload.elements[0]).toMatchObject({
      id: "password",
      label: "Password",
    });
    expect("value" in payload.elements[0]).toBe(false);
  });

  it("returns an empty element list for an empty view", () => {
    const registry = makeRegistry("empty", "xr");
    const payload = buildPayload(registry);
    expect(payload).toEqual({ viewId: "empty", viewType: "xr", elements: [] });
  });
});

describe("useAgentSurfaceElementReporter", () => {
  type ReporterProps = { registry: ViewAgentRegistry | null };
  let view: RenderHookResult<void, ReporterProps> | null = null;
  const originalNodeEnv = process.env.NODE_ENV;

  function renderReporter(registry: ViewAgentRegistry | null) {
    const mountedHook = renderHook(
      (props: ReporterProps) => useAgentSurfaceElementReporter(props.registry),
      { initialProps: { registry } },
    );
    view = mountedHook;
    return mountedHook;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithCsrfMock.mockClear();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    vi.useRealTimers();
  });

  async function advancePastDebounce(): Promise<void> {
    await vi.advanceTimersByTimeAsync(600);
  }

  function lastPostBody(): Record<string, unknown> {
    const calls = fetchWithCsrfMock.mock.calls;
    const init = calls[calls.length - 1]?.[1];
    return JSON.parse(String(init?.body));
  }

  it("is inert in the NODE_ENV=test runner regardless of registry state", async () => {
    const registry = makeRegistry();
    registry.register(
      { id: "amount", label: "Amount", getValue: () => "5" },
      () => null,
    );
    renderReporter(registry);

    await advancePastDebounce();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("does nothing with a null registry even outside the test environment", async () => {
    process.env.NODE_ENV = "production";
    renderReporter(null);

    await advancePastDebounce();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("posts the initial debounced snapshot to the view elements endpoint", async () => {
    process.env.NODE_ENV = "production";
    const registry = makeRegistry("wallet", "gui");
    registry.register(
      {
        id: "send.amount",
        label: "Amount",
        role: "text-input",
        sensitive: false,
        getValue: () => "5",
      },
      () => null,
    );
    renderReporter(registry);

    await advancePastDebounce();

    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithCsrfMock.mock.calls[0];
    expect(url).toBe("/api/views/wallet/elements");
    expect(init?.method).toBe("POST");
    expect(lastPostBody()).toEqual({
      elements: [
        { id: "send.amount", role: "text-input", label: "Amount", value: "5" },
      ],
      viewPath: "/chat",
      viewType: "gui",
    });
  });

  it("coalesces rapid registry updates into one debounced POST", async () => {
    process.env.NODE_ENV = "production";
    const registry = makeRegistry("wallet");
    registry.register({ id: "a", label: "A" }, () => null);
    renderReporter(registry);

    registry.touch();
    registry.register({ id: "b", label: "B" }, () => null);
    registry.touch();

    await advancePastDebounce();

    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
    expect(lastPostBody().elements).toHaveLength(2);
  });

  it("skips the POST when the snapshot has no elements", async () => {
    process.env.NODE_ENV = "production";
    const registry = makeRegistry("blank");
    renderReporter(registry);

    await advancePastDebounce();
    registry.touch();
    await advancePastDebounce();

    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("cancels the pending flush on unmount and ignores later updates", async () => {
    process.env.NODE_ENV = "production";
    const registry = makeRegistry("wallet");
    registry.register({ id: "a", label: "A" }, () => null);
    const mountedHook = renderReporter(registry);
    mountedHook.unmount();
    view = null;
    registry.touch(); // after unsubscribe this must not schedule anything

    await advancePastDebounce();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("re-subscribes when the registry instance changes, dropping the old flush", async () => {
    process.env.NODE_ENV = "production";
    const first = makeRegistry("view-a");
    first.register({ id: "a", label: "A" }, () => null);
    const mountedHook = renderReporter(first);

    const second = makeRegistry("view-b");
    second.register({ id: "b", label: "B" }, () => null);
    mountedHook.rerender({ registry: second });

    await advancePastDebounce();

    // view-a's pending timer was cancelled by the effect cleanup; only view-b reports.
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
    expect(fetchWithCsrfMock.mock.calls[0][0]).toBe(
      "/api/views/view-b/elements",
    );
    expect(lastPostBody().elements).toEqual([
      { id: "b", role: "region", label: "B" },
    ]);
  });
});
