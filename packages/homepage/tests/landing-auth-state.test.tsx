/**
 * Landing auth CTA regression: neutral Sign in always, never stale Dashboard.
 *
 * Repro (#28743): `packages/homepage/src/pages/landing.tsx` used
 * `localStorage.eliza_app_session` to decide between "Dashboard" and "Sign in".
 * That key is never set by the canonical Steward session, so the Dashboard
 * branch was unreachable for real logins and was reachable for stale legacy
 * storage. The marketing origin cannot observe the Cloud session directly
 * (different origins), so the truthful repair is a neutral CTA that never
 * fabricates a signed-in state from stale storage.
 *
 * Red: with `eliza_app_session` set, old code renders Dashboard.
 * Green: fixed code renders Sign in regardless of that key, and never exposes
 * a bearer token to the marketing origin.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ReactForStubs = await import("react");
const passthrough = (props: Record<string, unknown>) =>
  ReactForStubs.createElement("span", {
    className: props?.className as string,
  });

// Heavy UI leaf stubs — keep the page mountable in jsdom without Vite aliases.
mock.module("@elizaos/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: unknown }) =>
    ReactForStubs.createElement(
      "button",
      { type: "button", ...rest },
      children as never,
    ),
}));
mock.module("@elizaos/ui/cloud-ui/components/icons", () => ({
  DiscordIcon: passthrough,
  IMessageIcon: passthrough,
  TelegramIcon: passthrough,
}));
mock.module("@elizaos/ui/native-dialog", () => ({
  NativeDialog: ({ children }: { children?: unknown }) =>
    ReactForStubs.createElement("div", null, children as never),
}));
mock.module("@elizaos/ui/i18n/region", () => ({
  detectClientLanguage: () => "en",
}));
mock.module("@elizaos/shared/brand", () => ({
  BRAND_COLORS: new Proxy({}, { get: () => "#000000" }),
}));

// Vite's `@/` alias does not exist in bun test — map each homepage alias
// to its real module via import, then stub only the WebGL leaf.
mock.module("@/lib/contact", () => import("../src/lib/contact"));
mock.module("@/lib/landing-demo", () => import("../src/lib/landing-demo"));
mock.module(
  "@/lib/product-navigation",
  () => import("../src/lib/product-navigation"),
);
mock.module("@/components/landing-demo-attachment", () => ({
  isLandingDemoAttachmentStep: () => false,
  LandingDemoAttachment: () => null,
}));
mock.module("@/components/ShaderBackground/ShaderBackground", () => ({
  default: () => null,
}));

// I18n: return defaultValue directly so assertions can use the English copy.
mock.module("@/providers/I18nProvider", () => ({
  I18nProvider: ({ children }: { children: unknown }) => children,
  useT: () => (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
}));

mock.module(
  "@/lib/product-navigation",
  () => import("../src/lib/product-navigation"),
);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { JSDOM } = await import("jsdom");
const LandingPage = (await import("../src/pages/landing")).default;

function setupDom(url = "http://localhost/") {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.navigator = window.navigator;
  g.HTMLElement = window.HTMLElement;
  g.localStorage = window.localStorage;
  g.sessionStorage = window.sessionStorage;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // Landing types a demo — silence rAF-driven state updates for the auth check.
  const originalRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = ((_cb: FrameRequestCallback) =>
    originalRaf(() => {})) as typeof window.requestAnimationFrame;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  // jsdom's HTMLElement lacks scrollTo; Landing's thread pin calls it on mount.
  if (
    typeof (window.HTMLElement.prototype as unknown as { scrollTo?: unknown })
      .scrollTo !== "function"
  ) {
    (
      window.HTMLElement.prototype as unknown as Record<string, unknown>
    ).scrollTo = () => undefined;
  }
  if (
    typeof (window.Element.prototype as unknown as { scrollTo?: unknown })
      .scrollTo !== "function"
  ) {
    (window.Element.prototype as unknown as Record<string, unknown>).scrollTo =
      () => undefined;
  }
  // jsdom lacks these web APIs that LandingPage uses via useLayoutEffect
  // and useEffect; stubs keep the header mountable without a real layout engine.
  if (!(window as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
    class NoopResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as Record<string, unknown>).ResizeObserver =
      NoopResizeObserver as unknown as typeof ResizeObserver;
    (globalThis as unknown as Record<string, unknown>).ResizeObserver =
      NoopResizeObserver as unknown as typeof ResizeObserver;
  }
  if (typeof window.matchMedia !== "function") {
    (window as unknown as Record<string, unknown>).matchMedia = () =>
      ({
        matches: false,
        media: "",
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  return { window, dom };
}

async function renderLanding(
  init?: (storage: Storage) => void,
): Promise<{ container: Element; unmount: () => void }> {
  const { window } = setupDom();
  if (init) init(window.localStorage);
  const container = window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(LandingPage));
    await new Promise((r) => setTimeout(r, 50));
  });
  return {
    container,
    unmount: () => {
      React.act(() => root.unmount());
    },
  };
}

describe("LandingPage auth CTA", () => {
  beforeEach(() => {
    // Ensure clean storage between tests.
    try {
      globalThis.localStorage?.clear?.();
    } catch {}
  });
  afterEach(() => {
    try {
      globalThis.localStorage?.clear?.();
    } catch {}
  });

  test("renders Sign in when no session token exists", async () => {
    const { container, unmount } = await renderLanding();
    const headerCta = container.querySelector(
      ".landing-header-cta",
    ) as HTMLAnchorElement | null;
    expect(headerCta).not.toBeNull();
    expect(headerCta?.textContent).toBe("Sign in");
    expect(headerCta?.getAttribute("href")).toContain("/login");
    expect(
      container.querySelector(".landing-header-cta")?.textContent,
    ).not.toContain("Dashboard");
    // Never fabricates a signed-in state — absence assertion.
    expect(container.textContent).not.toContain("Dashboard");
    unmount();
  });

  test("renders Sign in even when legacy eliza_app_session is present (stale storage)", async () => {
    const { container, unmount } = await renderLanding((s) =>
      s.setItem("eliza_app_session", "stale-legacy-token"),
    );
    const headerCta = container.querySelector(
      ".landing-header-cta",
    ) as HTMLAnchorElement | null;
    expect(headerCta).not.toBeNull();
    // Old code would have rendered Dashboard here — this is the red->green check.
    expect(headerCta?.textContent).toBe("Sign in");
    expect(headerCta?.getAttribute("href")).toContain("/login");
    expect(headerCta?.getAttribute("href")).not.toContain("/cloud-apps");
    unmount();
  });

  test("renders Sign in for expired/revoked and logout states (no bearer exposure)", async () => {
    const { container: c1, unmount: u1 } = await renderLanding((s) =>
      s.setItem("eliza_app_session", "expired-token-123"),
    );
    expect(
      (c1.querySelector(".landing-header-cta") as HTMLAnchorElement)
        .textContent,
    ).toBe("Sign in");
    u1();
    // After logout (storage cleared), still Sign in — no stale Dashboard.
    const { container: c2, unmount: u2 } = await renderLanding();
    expect(
      (c2.querySelector(".landing-header-cta") as HTMLAnchorElement)
        .textContent,
    ).toBe("Sign in");
    u2();
  });

  test("never links to Dashboard from the marketing origin", async () => {
    const { container, unmount } = await renderLanding((s) =>
      s.setItem("eliza_app_session", "any-token"),
    );
    const links = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    // No link should point at the Cloud dashboard — marketing origin must not
    // claim a Cloud session it cannot verify.
    expect(links.some((h) => h?.includes("/cloud-apps"))).toBe(false);
    unmount();
  });
});
