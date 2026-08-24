/**
 * Unit coverage for the cloud-ui runtime navigation shim: internal-vs-external
 * href routing, same-origin href normalisation, scroll-to-top opt-out, replace /
 * reload / history delegation, the SPA notFound/redirect guards, and the
 * layout-segment / params / search-params hooks — driven through a real
 * MemoryRouter and asserted on the locations consumers actually receive.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notFound,
  redirect,
  useCallbackRouterPush,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
  useServerInsertedHTML,
} from "./navigation";

type ShimRouter = ReturnType<typeof useRouter>;

afterEach(cleanup);

describe("useRouter navigation", () => {
  const realLocation = window.location;
  let assignMock: ReturnType<typeof vi.fn>;
  let replaceLocationMock: ReturnType<typeof vi.fn>;
  let reloadMock: ReturnType<typeof vi.fn>;
  let scrollToMock: ReturnType<typeof vi.fn>;
  let routerRef: { current: ShimRouter | undefined };

  /** Renders the shim's own hooks so assertions hit real router state. */
  function RouterProbe({ tick }: { tick?: number }) {
    const router = useRouter();
    const { pathname, search, hash } = useLocation();
    const navType = useNavigationType();
    useEffect(() => {
      routerRef.current = router;
    });
    return (
      <div>
        {/* `tick` forces re-renders without changing any hook input. */}
        <span data-testid="tick">{tick ?? 0}</span>
        <span data-testid="pathname">{pathname}</span>
        <span data-testid="search">{search}</span>
        <span data-testid="hash">{hash}</span>
        <span data-testid="nav-type">{navType}</span>
      </div>
    );
  }

  function renderProbe(initialEntry: string, tick?: number) {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <RouterProbe tick={tick} />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    // jsdom forbids navigating and stubbing location.assign directly, so swap
    // the whole descriptor — the established pattern in this package's tests.
    assignMock = vi.fn();
    replaceLocationMock = vi.fn();
    reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...realLocation,
        origin: "http://localhost",
        href: "http://localhost/start",
        assign: assignMock,
        replace: replaceLocationMock,
        reload: reloadMock,
      },
    });
    // Pump scroll frames synchronously so scrollToTop is observable without
    // waiting out jsdom's real frame clock.
    scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(performance.now());
      return 0;
    });
    routerRef = { current: undefined };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("routes an internal push through the router to the target path", () => {
    renderProbe("/start");

    act(() => routerRef.current?.push("/agents"));

    expect(screen.getByTestId("pathname").textContent).toBe("/agents");
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("normalises a same-origin absolute URL down to path, search, and hash", () => {
    renderProbe("/start");

    act(() =>
      routerRef.current?.push(
        "http://localhost/dashboard/settings?tab=api#keys",
      ),
    );

    expect(screen.getByTestId("pathname").textContent).toBe(
      "/dashboard/settings",
    );
    expect(screen.getByTestId("nav-type").textContent).toBe("PUSH");
  });

  it("keeps query and hash on a plain internal push", () => {
    renderProbe("/start");

    act(() => routerRef.current?.push("/instances?status=live#top"));

    expect(screen.getByTestId("pathname").textContent).toBe("/instances");
    expect(screen.getByTestId("search").textContent).toBe("?status=live");
    expect(screen.getByTestId("hash").textContent).toBe("#top");
  });

  it("passes an unparseable href to the router unchanged instead of escaping to the browser", () => {
    renderProbe("/start");

    act(() => routerRef.current?.push("http://[::1"));

    expect(assignMock).not.toHaveBeenCalled();
    // Observed: the router keeps the raw href as a relative path ("/" +
    // collapsed scheme) — it never reaches window.location.
    expect(screen.getByTestId("pathname").textContent).toBe("/http:/[::1");
  });

  it("sends an external push to window.location.assign and leaves the router untouched", () => {
    renderProbe("/start");

    act(() => routerRef.current?.push("https://docs.elizaos.example/guide"));

    expect(assignMock).toHaveBeenCalledWith(
      "https://docs.elizaos.example/guide",
    );
    expect(screen.getByTestId("pathname").textContent).toBe("/start");
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("routes an internal replace through the router with REPLACE navigation type", () => {
    renderProbe("/start");

    act(() => routerRef.current?.replace("/agents"));

    expect(screen.getByTestId("pathname").textContent).toBe("/agents");
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
  });

  it("sends an external replace to window.location.replace", () => {
    renderProbe("/start");

    act(() =>
      routerRef.current?.replace("https://console.elizaos.example/login"),
    );

    expect(replaceLocationMock).toHaveBeenCalledWith(
      "https://console.elizaos.example/login",
    );
    expect(screen.getByTestId("pathname").textContent).toBe("/start");
  });

  it("scrolls to top by default after an internal push", () => {
    renderProbe("/start");

    act(() => routerRef.current?.push("/next"));

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, left: 0 });
  });

  it("skips the scroll-to-top when an internal push opts out", () => {
    renderProbe("/start");

    act(() => routerRef.current?.push("/next", { scroll: false }));

    expect(screen.getByTestId("pathname").textContent).toBe("/next");
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("delegates refresh to a full window reload", () => {
    renderProbe("/start");

    act(() => routerRef.current?.refresh());

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("delegates back and forward to the browser history stack", () => {
    renderProbe("/start");
    const backSpy = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    const forwardSpy = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});

    act(() => routerRef.current?.back());
    act(() => routerRef.current?.forward());

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves prefetch as a no-op without navigating", async () => {
    renderProbe("/start");

    await expect(
      routerRef.current?.prefetch("/later"),
    ).resolves.toBeUndefined();

    expect(screen.getByTestId("pathname").textContent).toBe("/start");
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("returns one stable router instance across re-renders", () => {
    const view = renderProbe("/start", 1);
    const stable = routerRef.current;

    view.rerender(
      <MemoryRouter initialEntries={["/start"]}>
        <RouterProbe tick={2} />
      </MemoryRouter>,
    );

    expect(routerRef.current).toBe(stable);
  });
});

describe("redirect and notFound runtime guards", () => {
  const realLocation = window.location;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, assign: assignMock },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("throws the SPA unsupported error from notFound()", () => {
    expect(() => notFound()).toThrow(
      "notFound() is not supported in the SPA runtime",
    );
  });

  it("assigns the browser location before throwing from redirect()", () => {
    expect(() => redirect("https://accounts.elizaos.example/signin")).toThrow(
      "redirected to https://accounts.elizaos.example/signin",
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://accounts.elizaos.example/signin",
    );
  });
});

describe("layout segment hooks", () => {
  const wrapper =
    (initialEntry: string) =>
    ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
    );

  it("returns every non-empty segment for a nested path", () => {
    const { result } = renderHook(() => useSelectedLayoutSegments(), {
      wrapper: wrapper("/agents/profiler/settings"),
    });

    expect(result.current).toEqual(["agents", "profiler", "settings"]);
  });

  it("collapses trailing slashes to defined segments", () => {
    const { result } = renderHook(() => useSelectedLayoutSegments(), {
      wrapper: wrapper("/agents/"),
    });

    expect(result.current).toEqual(["agents"]);
  });

  it("returns an empty segment list at the root path", () => {
    const { result } = renderHook(() => useSelectedLayoutSegments(), {
      wrapper: wrapper("/"),
    });

    expect(result.current).toEqual([]);
  });

  it("returns the deepest segment, or null at the root", () => {
    const nested = renderHook(() => useSelectedLayoutSegment(), {
      wrapper: wrapper("/agents/profiler/settings"),
    });
    expect(nested.result.current).toBe("settings");

    const root = renderHook(() => useSelectedLayoutSegment(), {
      wrapper: wrapper("/"),
    });
    expect(root.result.current).toBeNull();
  });
});

describe("param and search-param hooks", () => {
  function ParamProbe() {
    const params = useParams<{ id: string }>();
    return <span data-testid="param-id">{params.id}</span>;
  }

  it("surfaces typed route params through the shim", () => {
    render(
      <MemoryRouter initialEntries={["/agents/test-agent-1"]}>
        <Routes>
          <Route path="/agents/:id" element={<ParamProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("param-id").textContent).toBe("test-agent-1");
  });

  it("exposes the current search params as a URLSearchParams view", () => {
    const { result } = renderHook(() => useSearchParams(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={["/billing?plan=pro&cycle=annual"]}>
          {children}
        </MemoryRouter>
      ),
    });

    expect(result.current).toBeInstanceOf(URLSearchParams);
    expect(result.current.get("plan")).toBe("pro");
    expect(result.current.get("cycle")).toBe("annual");
  });

  it("reports the router pathname through the shim", () => {
    const { result } = renderHook(() => usePathname(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={["/dashboard/overview"]}>
          {children}
        </MemoryRouter>
      ),
    });

    expect(result.current).toBe("/dashboard/overview");
  });
});

describe("useCallbackRouterPush", () => {
  const callbackPushRef: { current: (() => void) | null } = { current: null };

  function CallbackPushProbe({ href }: { href: string }) {
    const push = useCallbackRouterPush(href);
    const pathname = usePathname();
    useEffect(() => {
      callbackPushRef.current = push;
    });
    return <span data-testid="cb-push-pathname">{pathname}</span>;
  }

  function renderAt(href: string, entry = "/start") {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <CallbackPushProbe href={href} />
      </MemoryRouter>,
    );
  }

  it("pushes its bound href through the real router when invoked", () => {
    renderAt("/invite/friends");

    act(() => callbackPushRef.current?.());

    expect(screen.getByTestId("cb-push-pathname").textContent).toBe(
      "/invite/friends",
    );
  });

  it("keeps the callback referentially stable while the bound href is unchanged", () => {
    const view = renderAt("/invite/friends");
    const stable = callbackPushRef.current;

    view.rerender(
      <MemoryRouter initialEntries={["/start"]}>
        <CallbackPushProbe href="/invite/friends" />
      </MemoryRouter>,
    );

    expect(callbackPushRef.current).toBe(stable);
  });

  it("rebinds to a fresh callback when the bound href changes", () => {
    const view = renderAt("/invite/friends");
    const original = callbackPushRef.current;

    view.rerender(
      <MemoryRouter initialEntries={["/start"]}>
        <CallbackPushProbe href="/invite/partners" />
      </MemoryRouter>,
    );

    expect(callbackPushRef.current).not.toBe(original);
  });
});

describe("useServerInsertedHTML", () => {
  it("ignores the insertion callback in the SPA runtime", () => {
    const callback = vi.fn();

    expect(useServerInsertedHTML(callback)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });
});
