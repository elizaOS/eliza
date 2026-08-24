/** Verifies the @elizaos/ui/cloud-ui barrel wires consumers to canonical modules and its runtime shims behave. */
// @vitest-environment jsdom
/**
 * Unit coverage for packages/ui/src/cloud-ui/index.ts. The barrel's
 * consumer-facing contract is exercised two ways: every re-export resolves to
 * the SAME module instance as its canonical source (no shadow copies of
 * primitives or compositions — React context/state break otherwise), and the
 * runtime shims it publishes (Image, dynamic, navigation, render telemetry)
 * behave at their real boundaries. All subjects are driven through the barrel
 * import itself; harness is vitest + jsdom with an in-memory react-router and
 * no network.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import {
  type AnyRenderTelemetryEvent,
  currentRoute,
  emitRenderTelemetry,
  isRenderTelemetryEnabled,
  nextRenderTelemetrySequence,
  RENDER_TELEMETRY_EVENT,
  setRenderTelemetrySink,
} from "../hooks/useRenderGuard";
import {
  CostAlerts,
  CostInsightsCard,
  ExportButton,
} from "./components/analytics";
import {
  BulkDeleteDialog,
  BulkSelectionBar,
  runBulkDelete,
} from "./components/bulk/bulk-select";
import * as cloudUi from "./index";
import defaultDynamic from "./runtime/dynamic";
import defaultImage from "./runtime/image";
import { RenderTelemetryProfiler } from "./runtime/render-telemetry";

type RouterLike = ReturnType<typeof cloudUi.useRouter>;

type TelemetryGlobals = typeof globalThis & {
  __ELIZA_RENDER_TELEMETRY_ENABLED__?: boolean;
  __ELIZA_RENDER_TELEMETRY_DISABLED__?: boolean;
  __ELIZA_RENDER_TELEMETRY__?: AnyRenderTelemetryEvent[];
};

const telemetryGlobals = globalThis as TelemetryGlobals;

const originalDescriptors = {
  location: Object.getOwnPropertyDescriptor(window, "location"),
  requestAnimationFrame: Object.getOwnPropertyDescriptor(
    window,
    "requestAnimationFrame",
  ),
  scrollTo: Object.getOwnPropertyDescriptor(window, "scrollTo"),
};

/** Swap window.location/rAF/scrollTo for inert recording stand-ins during router-shim tests. */
function stubBrowserShell(location: Record<string, unknown>): {
  assign: ReturnType<typeof vi.fn>;
} {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost", assign, ...location },
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  return { assign };
}

function restoreBrowserShell(): void {
  const pairs = [
    ["location", originalDescriptors.location],
    ["requestAnimationFrame", originalDescriptors.requestAnimationFrame],
    ["scrollTo", originalDescriptors.scrollTo],
  ] as const;
  for (const [key, descriptor] of pairs) {
    if (descriptor) {
      Object.defineProperty(window, key, descriptor);
    }
  }
}

afterEach(() => {
  cleanup();
  restoreBrowserShell();
  cloudUi.setRenderTelemetrySink(null);
  delete telemetryGlobals.__ELIZA_RENDER_TELEMETRY_ENABLED__;
  delete telemetryGlobals.__ELIZA_RENDER_TELEMETRY_DISABLED__;
  telemetryGlobals.__ELIZA_RENDER_TELEMETRY__ = undefined;
  vi.restoreAllMocks();
});

describe("cloud-ui barrel canonical module identity", () => {
  it("re-exports the canonical tabs primitive instances, not copies", () => {
    expect(cloudUi.Tabs).toBe(Tabs);
    expect(cloudUi.TabsContent).toBe(TabsContent);
    expect(cloudUi.TabsList).toBe(TabsList);
    expect(cloudUi.TabsTrigger).toBe(TabsTrigger);
  });

  it("re-exports the canonical analytics and bulk-selection implementations", () => {
    expect(cloudUi.CostAlerts).toBe(CostAlerts);
    expect(cloudUi.CostInsightsCard).toBe(CostInsightsCard);
    expect(cloudUi.ExportButton).toBe(ExportButton);
    expect(cloudUi.BulkDeleteDialog).toBe(BulkDeleteDialog);
    expect(cloudUi.BulkSelectionBar).toBe(BulkSelectionBar);
    expect(cloudUi.runBulkDelete).toBe(runBulkDelete);
  });

  it("publishes the canonical runtime shim defaults", () => {
    expect(cloudUi.dynamic).toBe(defaultDynamic);
    expect(cloudUi.Image).toBe(defaultImage);
    expect(cloudUi.RenderTelemetryProfiler).toBe(RenderTelemetryProfiler);
  });

  it("publishes the canonical render-telemetry surface", () => {
    expect(cloudUi.RENDER_TELEMETRY_EVENT).toBe(RENDER_TELEMETRY_EVENT);
    expect(cloudUi.setRenderTelemetrySink).toBe(setRenderTelemetrySink);
    expect(cloudUi.emitRenderTelemetry).toBe(emitRenderTelemetry);
    expect(cloudUi.nextRenderTelemetrySequence).toBe(
      nextRenderTelemetrySequence,
    );
    expect(cloudUi.isRenderTelemetryEnabled).toBe(isRenderTelemetryEnabled);
    expect(cloudUi.currentRoute).toBe(currentRoute);
  });
});

describe("cloud-ui barrel Image shim", () => {
  it("forces lazy loading and forwards source, alt text, and geometry", () => {
    render(
      <cloudUi.Image
        src="/brand/logo.png"
        alt="Eliza logo"
        width={48}
        height={24}
      />,
    );
    const img = screen.getByRole("img", { name: "Eliza logo" });
    expect(img.getAttribute("src")).toBe("/brand/logo.png");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("width")).toBe("48");
    expect(img.getAttribute("height")).toBe("24");
  });

  it("applies the absolute full-bleed treatment when fill is set", () => {
    render(<cloudUi.Image src="/hero.png" alt="hero" fill />);
    const img = screen.getByRole("img", { name: "hero" });
    expect(img.style.position).toBe("absolute");
    expect(img.style.width).toBe("100%");
    expect(img.style.height).toBe("100%");
  });

  it("passes caller styles through untouched when fill is unset", () => {
    render(
      <cloudUi.Image
        src="/inline.png"
        alt="inline"
        style={{ position: "relative", width: "12px" }}
      />,
    );
    const img = screen.getByRole("img", { name: "inline" });
    expect(img.style.position).toBe("relative");
    expect(img.style.width).toBe("12px");
  });
});

describe("cloud-ui barrel dynamic() loader", () => {
  it("resolves default-shaped modules through Suspense", async () => {
    const Loaded = cloudUi.dynamic(async () => ({
      default: () => <p>lazy-default-form</p>,
    }));
    render(<Loaded />);
    expect(await screen.findByText("lazy-default-form")).toBeTruthy();
  });

  it("accepts bare component modules and forwards props", async () => {
    const Loaded = cloudUi.dynamic(async () => (props: { label: string }) => (
      <p>{props.label}</p>
    ));
    render(<Loaded label="fn-form-prop" />);
    expect(await screen.findByText("fn-form-prop")).toBeTruthy();
  });

  it("shows the loading fallback while the loader is pending", () => {
    const Loaded = cloudUi.dynamic(
      () => new Promise<{ default: () => ReactElement }>(() => {}),
      { loading: () => <p>panel-booting</p> },
    );
    render(<Loaded />);
    expect(screen.getByText("panel-booting")).toBeTruthy();
    expect(screen.queryByText("lazy-content")).toBeNull();
  });
});

describe("cloud-ui barrel render-telemetry plumbing", () => {
  it("allocates monotonic telemetry sequences across emitters", () => {
    const first = cloudUi.nextRenderTelemetrySequence();
    const second = cloudUi.nextRenderTelemetrySequence();
    expect(second).toBe(first + 1);
  });

  it("fans an emitted event out to the sink, the window event, and the global bucket", () => {
    const sinkEvents: AnyRenderTelemetryEvent[] = [];
    cloudUi.setRenderTelemetrySink((event) => sinkEvents.push(event));
    const bucket: AnyRenderTelemetryEvent[] = [];
    telemetryGlobals.__ELIZA_RENDER_TELEMETRY__ = bucket;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const received: CustomEvent<AnyRenderTelemetryEvent>[] = [];
    const listener = (event: Event) =>
      received.push(event as CustomEvent<AnyRenderTelemetryEvent>);
    window.addEventListener(cloudUi.RENDER_TELEMETRY_EVENT, listener);

    try {
      const event: AnyRenderTelemetryEvent = {
        source: "useRenderGuard",
        name: "CostPanel",
        severity: "info",
        renderCount: 61,
        threshold: 60,
        windowMs: 1000,
        timestamps: [Date.now()],
        at: Date.now(),
        sequence: cloudUi.nextRenderTelemetrySequence(),
      };
      cloudUi.emitRenderTelemetry(event);

      expect(sinkEvents).toEqual([event]);
      expect(received).toHaveLength(1);
      expect(received[0].detail).toBe(event);
      expect(bucket).toEqual([event]);
      expect(infoSpy).toHaveBeenCalledOnce();
      expect(String(infoSpy.mock.calls[0][0])).toContain("CostPanel");
    } finally {
      window.removeEventListener(cloudUi.RENDER_TELEMETRY_EVENT, listener);
    }
  });

  it("lets the disable flag win over the enable flag and lets the enable flag force telemetry on", () => {
    telemetryGlobals.__ELIZA_RENDER_TELEMETRY_DISABLED__ = true;
    telemetryGlobals.__ELIZA_RENDER_TELEMETRY_ENABLED__ = true;
    expect(cloudUi.isRenderTelemetryEnabled()).toBe(false);

    delete telemetryGlobals.__ELIZA_RENDER_TELEMETRY_DISABLED__;
    expect(cloudUi.isRenderTelemetryEnabled()).toBe(true);
  });

  it("reports the current jsdom route for telemetry attribution", () => {
    expect(cloudUi.currentRoute()).toBe("/");
  });
});

describe("cloud-ui barrel navigation shims", () => {
  it("normalizes same-origin absolute URLs into router pushes", async () => {
    stubBrowserShell({});
    const grab: { router: RouterLike | null } = { router: null };
    const loc: { current: ReturnType<typeof useLocation> | null } = {
      current: null,
    };

    function Probe() {
      grab.router = cloudUi.useRouter();
      loc.current = useLocation();
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      grab.router?.push("http://localhost/settings?tab=api#keys");
    });

    await waitFor(() => {
      expect(loc.current?.pathname).toBe("/settings");
    });
    expect(loc.current?.search).toBe("?tab=api");
    expect(loc.current?.hash).toBe("#keys");
  });

  it("routes off-origin hrefs to window.location.assign instead of the router", () => {
    const shell = stubBrowserShell({ pathname: "/" });
    const grab: { router: RouterLike | null } = { router: null };
    const loc: { current: ReturnType<typeof useLocation> | null } = {
      current: null,
    };

    function Probe() {
      grab.router = cloudUi.useRouter();
      loc.current = useLocation();
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      grab.router?.push("https://status.elizaos.example/incident");
    });

    expect(shell.assign).toHaveBeenCalledWith(
      "https://status.elizaos.example/incident",
    );
    expect(loc.current?.pathname).toBe("/");
  });

  it("navigates replace requests to the normalized target", async () => {
    stubBrowserShell({});
    const grab: { router: RouterLike | null } = { router: null };
    const loc: { current: ReturnType<typeof useLocation> | null } = {
      current: null,
    };

    function Probe() {
      grab.router = cloudUi.useRouter();
      loc.current = useLocation();
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      grab.router?.replace("http://localhost/library#top");
    });

    await waitFor(() => {
      expect(loc.current?.pathname).toBe("/library");
    });
    expect(loc.current?.hash).toBe("#top");
    expect(loc.current?.search).toBe("");
  });

  it("throws the SPA notFound contract", () => {
    expect(() => cloudUi.notFound()).toThrowError(
      "notFound() is not supported in the SPA runtime",
    );
  });

  it("assigns the redirect target and then throws the redirect marker", () => {
    const shell = stubBrowserShell({});
    expect(() =>
      cloudUi.redirect("https://auth.elizaos.example/start"),
    ).toThrowError(/^redirected to https:\/\/auth\.elizaos\.example\/start$/);
    expect(shell.assign).toHaveBeenCalledWith(
      "https://auth.elizaos.example/start",
    );
  });

  it("derives the selected layout segment(s) from the live pathname", () => {
    const results: { segment: string | null; segments: string[] } = {
      segment: null,
      segments: [],
    };

    function Probe() {
      results.segment = cloudUi.useSelectedLayoutSegment();
      results.segments = cloudUi.useSelectedLayoutSegments();
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/cloud/agents/detail"]}>
        <Probe />
      </MemoryRouter>,
    );

    expect(results.segment).toBe("detail");
    expect(results.segments).toEqual(["cloud", "agents", "detail"]);
  });

  it("returns an empty segment list and a null segment at the root route", () => {
    const results: { segment: string | null; segments: string[] } = {
      segment: null,
      segments: [],
    };

    function Probe() {
      results.segment = cloudUi.useSelectedLayoutSegment();
      results.segments = cloudUi.useSelectedLayoutSegments();
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    expect(results.segment).toBeNull();
    expect(results.segments).toEqual([]);
  });

  it("exposes the live pathname and parsed search params", () => {
    const results: { pathname: string; key: string | null } = {
      pathname: "",
      key: null,
    };

    function Probe() {
      results.pathname = cloudUi.usePathname();
      results.key = cloudUi.useSearchParams().get("key");
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/console?key=abc"]}>
        <Probe />
      </MemoryRouter>,
    );

    expect(results.pathname).toBe("/console");
    expect(results.key).toBe("abc");
  });

  it("hands callers a stable push callback bound to its href", async () => {
    stubBrowserShell({});
    const grab: { callback: (() => void) | null } = { callback: null };
    const loc: { current: ReturnType<typeof useLocation> | null } = {
      current: null,
    };

    function Probe() {
      grab.callback = cloudUi.useCallbackRouterPush("/billing?plan=pro");
      loc.current = useLocation();
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      grab.callback?.();
    });

    await waitFor(() => {
      expect(loc.current?.pathname).toBe("/billing");
    });
    expect(loc.current?.search).toBe("?plan=pro");
  });
});

describe("cloud-ui barrel useRenderGuard re-export", () => {
  it("stays silent while commits stay far below the loop threshold", () => {
    telemetryGlobals.__ELIZA_RENDER_TELEMETRY_ENABLED__ = true;
    const sink = vi.fn();
    cloudUi.setRenderTelemetrySink(sink);

    function Guarded() {
      cloudUi.useRenderGuard("cloud-ui-barrel-probe");
      return <p>guard-probe</p>;
    }

    const view = render(<Guarded />);
    for (let i = 0; i < 5; i += 1) {
      view.rerender(<Guarded />);
    }
    expect(screen.getByText("guard-probe")).toBeTruthy();
    expect(sink).not.toHaveBeenCalled();
  });
});
