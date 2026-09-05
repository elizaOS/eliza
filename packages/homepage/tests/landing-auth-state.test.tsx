/**
 * Landing auth CTA regression in a deterministic mocked-jsdom harness:
 * neutral Sign in always, never inferred Dashboard.
 *
 * Repro (#28743): `packages/homepage/src/pages/landing.tsx` used
 * `localStorage.eliza_app_session` to decide between "Dashboard" and "Sign in".
 * That key is real same-origin homepage session state (written by homepage
 * login), but it cannot attest the separate Cloud-app origin session — so the
 * Dashboard branch fabricated cross-origin session knowledge. The truthful
 * repair is a neutral CTA that never infers Cloud signed-in state from the
 * homepage token.
 *
 * Red: with `eliza_app_session` set, old code renders Dashboard.
 * Green: fixed code renders Sign in regardless of that key. This local harness
 * does not exercise a live Cloud session, revocation, or bearer transport.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

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

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { JSDOM } = await import("jsdom");
const LandingPage = (await import("../src/pages/landing")).default;

const DOM_GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "localStorage",
  "sessionStorage",
  "ResizeObserver",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const activeCleanups = new Set<() => Promise<void>>();

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

function setupDom(url = "http://localhost/") {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  const priorDescriptors = new Map(
    DOM_GLOBAL_KEYS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const restoreGlobals = () => {
    for (const key of DOM_GLOBAL_KEYS) {
      restoreProperty(globalThis, key, priorDescriptors.get(key));
    }
  };
  let setupComplete = false;
  try {
    Object.defineProperties(g, {
      window: { configurable: true, writable: true, value: window },
      document: {
        configurable: true,
        writable: true,
        value: window.document,
      },
      navigator: {
        configurable: true,
        writable: true,
        value: window.navigator,
      },
      HTMLElement: {
        configurable: true,
        writable: true,
        value: window.HTMLElement,
      },
      localStorage: {
        configurable: true,
        writable: true,
        value: window.localStorage,
      },
      sessionStorage: {
        configurable: true,
        writable: true,
        value: window.sessionStorage,
      },
      IS_REACT_ACT_ENVIRONMENT: {
        configurable: true,
        writable: true,
        value: true,
      },
    });
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
      (
        window.Element.prototype as unknown as Record<string, unknown>
      ).scrollTo = () => undefined;
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
    setupComplete = true;
  } finally {
    if (!setupComplete) {
      try {
        dom.window.close();
      } finally {
        restoreGlobals();
      }
    }
  }
  return { window, dom, restoreGlobals };
}

async function renderLanding(
  init?: (storage: Storage) => void,
): Promise<{ container: Element; unmount: () => Promise<void> }> {
  const { window, dom, restoreGlobals } = setupDom();
  let root: ReturnType<typeof createRoot> | null = null;
  let cleaned = false;
  const unmount = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (root) await React.act(async () => root?.unmount());
    } finally {
      try {
        dom.window.close();
      } finally {
        try {
          restoreGlobals();
        } finally {
          activeCleanups.delete(unmount);
        }
      }
    }
  };
  activeCleanups.add(unmount);
  if (init) init(window.localStorage);
  const container = window.document.getElementById("root") as HTMLElement;
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(LandingPage));
    await new Promise((r) => setTimeout(r, 50));
  });
  return {
    container,
    unmount,
  };
}

describe("LandingPage auth CTA", () => {
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [...activeCleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        // error-policy:J2 Collect every cleanup failure, then rethrow them as one AggregateError.
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "DOM cleanup failed");
  });

  test("renders Sign in when no session token exists", async () => {
    const { container } = await renderLanding();
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
  });

  test("renders Sign in even when a homepage eliza_app_session token is present (not Cloud attestation)", async () => {
    const { container } = await renderLanding((s) =>
      s.setItem("eliza_app_session", "homepage-session-token"),
    );
    const headerCta = container.querySelector(
      ".landing-header-cta",
    ) as HTMLAnchorElement | null;
    expect(headerCta).not.toBeNull();
    // Old code would have rendered Dashboard here — this is the red->green check.
    expect(headerCta?.textContent).toBe("Sign in");
    expect(headerCta?.getAttribute("href")).toContain("/login");
    expect(headerCta?.getAttribute("href")).not.toContain("/cloud-apps");
  });

  test("renders Sign in for an arbitrary homepage token and cleared storage", async () => {
    const { container: c1, unmount: u1 } = await renderLanding((s) =>
      s.setItem("eliza_app_session", "opaque-homepage-token"),
    );
    expect(
      (c1.querySelector(".landing-header-cta") as HTMLAnchorElement)
        .textContent,
    ).toBe("Sign in");
    await u1();
    // After homepage storage is cleared, still Sign in — no inferred Dashboard.
    const { container: c2, unmount: u2 } = await renderLanding();
    expect(
      (c2.querySelector(".landing-header-cta") as HTMLAnchorElement)
        .textContent,
    ).toBe("Sign in");
    await u2();
  });

  test("never links account CTAs to Dashboard from the marketing origin", async () => {
    const { container } = await renderLanding((s) =>
      s.setItem("eliza_app_session", "any-token"),
    );
    const accountLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        ".landing-header-cta, .landing-sheet-row--account",
      ),
    );
    expect(accountLinks).toHaveLength(2);
    for (const link of accountLinks) {
      expect(link.getAttribute("href")).toContain("/login");
      expect(link.getAttribute("href")).not.toContain("/cloud-apps");
    }
  });
});
