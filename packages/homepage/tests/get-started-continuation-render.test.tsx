/**
 * Page-level render proof for the platform-continuation seam on /get-started.
 *
 * Repro (Shadow, 2026-08-11): DM the Discord bot -> tap Connect ->
 * https://eliza.app/get-started/?onboardingSession=<id> while SIGNED OUT
 * rendered the connector picker ("Anywhere you want her to be.") — a dead end
 * for someone who already came from Discord. This mounts the real
 * GetStartedPage in jsdom and proves:
 *
 * - onboardingSession + unauthenticated renders the SIGN-IN step, not the
 *   connector picker (fails on develop, passes with the fix)
 * - authenticated messaging continuations preview and explicitly confirm the
 *   attested Discord or Telegram identity before returning to that platform
 * - transient preview failures retry in place while deliberate non-linkable
 *   responses retain the phone-style provisioning fallback
 * - a consent-denied OAuth return restores only a state-matched continuation
 * - no onboardingSession still renders the picker (no regression)
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---- Auth context mock (configurable per test) -----------------------------
let authState = {
  isAuthenticated: false,
  isLoading: false,
};

const authMock = {
  useAuth: () => ({
    user: null,
    organization: null,
    isLoading: authState.isLoading,
    isAuthenticated: authState.isAuthenticated,
    error: null,
    loginWithTelegram: mock(async () => ({ success: false })),
    loginWithDiscord: mock(async () => ({ success: false })),
    loginWithWhatsApp: mock(async () => ({ success: false })),
    loginWithSolana: mock(async () => ({ success: false })),
    linkPhone: mock(async () => ({ success: false })),
    logout: mock(() => undefined),
    refreshUser: mock(async () => undefined),
  }),
  getAuthToken: () => null,
  AuthProvider: ({ children }: { children: unknown }) => children,
};
mock.module("@/lib/context/auth-context", () => authMock);

// Network guard: neither the provisioning-chat hook nor the continuation
// link step may reach the real API. GET (params, no method) serves the
// Discord continuation preview; POST serves both the provisioning chat and
// the confirmPlatformLink redemption.
let previewResult: {
  platform: string;
  platformUserId: string;
  platformDisplayName: string;
} | null = {
  platform: "discord",
  platformUserId: "555001122334455667",
  platformDisplayName: "shadow#0001",
};
let previewError: Error | null = null;
const chatFetch = mock(async (_path: string, init?: RequestInit) => {
  const isPreview = !init?.method || init.method === "GET";
  if (isPreview && !init?.body) {
    if (previewError) throw previewError;
    if (!previewResult) {
      throw new Error("elizacloud API error 403: continuation invalid");
    }
    return { success: true, data: previewResult };
  }
  return {
    success: true,
    data: {
      provisioning: { status: "pending", agentId: null, bridgeUrl: null },
      messages: [],
    },
  };
});
mock.module("@/lib/api/client", () => ({
  elizacloudAuthFetch: chatFetch,
  elizacloudFetch: chatFetch,
  getAuthToken: () => null,
  getElizacloudUrl: () => "https://staging.elizacloud.ai",
}));

// The WebGL shader background cannot exist in jsdom.
mock.module("@/components/ShaderBackground/ShaderBackground", () => ({
  default: () => null,
}));

// Workspace packages resolve through Vite aliases in the app build; bun test
// has no Vite, so stub the small leaf modules the page imports.
const ReactForStubs = await import("react");
const passthrough = (props: Record<string, unknown>) =>
  ReactForStubs.createElement("span", {
    className: props?.className as string,
  });
mock.module("@elizaos/ui/i18n/region", () => ({
  detectClientLanguage: () => "en",
}));
mock.module("@elizaos/shared/brand", () => ({
  BRAND_COLORS: new Proxy({}, { get: () => "#000000" }),
}));
mock.module("@elizaos/ui/button", () => ({
  Button: ({
    children,
    asChild: _asChild,
    ...rest
  }: {
    children?: unknown;
    asChild?: boolean;
  }) =>
    ReactForStubs.createElement(
      "button",
      { type: "button", ...rest },
      children as never,
    ),
}));
mock.module("@elizaos/ui/input", () => ({
  Input: (props: Record<string, unknown>) =>
    ReactForStubs.createElement("input", props),
}));
mock.module("@elizaos/ui/cloud-ui/components/icons", () => ({
  DiscordIcon: passthrough,
  IMessageIcon: passthrough,
  TelegramIcon: passthrough,
  WhatsAppIcon: passthrough,
}));

// The "@/" alias lives in tsconfig.app.json (Vite), which bun test does not
// read — map each aliased import the page pulls in to its real module.
mock.module("@/lib/auth-return", () => import("../src/lib/auth-return"));
mock.module(
  "@/lib/onboarding-continuation",
  () => import("../src/lib/onboarding-continuation"),
);
mock.module("@/lib/contact", () => import("../src/lib/contact"));
mock.module(
  "@/lib/telegram-onboarding",
  () => import("../src/lib/telegram-onboarding"),
);
mock.module(
  "@/lib/provisioning-poll-body",
  () => import("../src/lib/provisioning-poll-body"),
);
mock.module(
  "@/lib/hooks/use-eliza-app-provisioning-chat",
  () => import("../src/lib/hooks/use-eliza-app-provisioning-chat"),
);
mock.module(
  "@/providers/I18nProvider",
  () => import("../src/providers/I18nProvider"),
);
mock.module(
  "@/components/brand/eliza-logo",
  () => import("../src/components/brand/eliza-logo"),
);
mock.module(
  "@/components/login/phone-number-input",
  () => import("../src/components/login/phone-number-input"),
);
mock.module(
  "@/components/login/country-flag",
  () => import("../src/components/login/country-flag"),
);

// Import after mocks are registered.
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider } = await import("../src/providers/I18nProvider");
const { JSDOM } = await import("jsdom");
const GetStartedPage = (await import("../src/pages/get-started")).default;

const PICKER_HEADER = "Anywhere you want her to be.";
const SIGN_IN_HEADER = "Sign in to continue";

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/get-started",
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
  // jsdom has no layout engine; the provisioning chat autoscrolls on mount.
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  return window as unknown as Window & typeof globalThis;
}

async function renderPage(
  url: string,
  initializeStorage?: (storage: Storage) => void,
): Promise<{
  html: () => string;
  query: (testId: string) => Element | null;
  unmount: () => void;
}> {
  const window = setupDom();
  initializeStorage?.(window.sessionStorage);
  const container = window.document.getElementById("root");
  if (!container) throw new Error("root element not found");
  const root = createRoot(container);
  root.render(
    React.createElement(
      I18nProvider,
      { initialLang: "en" },
      React.createElement(
        MemoryRouter,
        { initialEntries: [url] },
        React.createElement(GetStartedPage),
      ),
    ),
  );
  // Let effects (initial-step resolution) settle.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    html: () => container.innerHTML,
    query: (testId: string) =>
      container.querySelector(`[data-testid="${testId}"]`),
    unmount: () => root.unmount(),
  };
}

describe("GetStartedPage platform continuation", () => {
  beforeEach(() => {
    authState = { isAuthenticated: false, isLoading: false };
    previewResult = {
      platform: "discord",
      platformUserId: "555001122334455667",
      platformDisplayName: "shadow#0001",
    };
    previewError = null;
    chatFetch.mockClear();
  });

  afterEach(() => {
    // jsdom instances are replaced per render via setupDom.
  });

  test("onboardingSession + unauthenticated renders sign-in, NOT the connector picker", async () => {
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    expect(page.html()).toContain(SIGN_IN_HEADER);
    expect(page.query("onboarding-signin-discord")).not.toBeNull();
    expect(page.html()).not.toContain(PICKER_HEADER);

    page.unmount();
  });

  test("onboardingSession + authenticated shows the Discord link confirmation, not a web chat", async () => {
    authState = { isAuthenticated: true, isLoading: false };
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    expect(page.html()).not.toContain(PICKER_HEADER);
    expect(page.html()).not.toContain(SIGN_IN_HEADER);
    // Preview/confirm handoff (#18161 contract): informed confirmation first.
    expect(page.query("continuation-confirm")).not.toBeNull();
    expect(page.html()).toContain("shadow#0001");

    page.unmount();
  });

  test("confirming the link lands on the 'head back to Discord' terminal state", async () => {
    authState = { isAuthenticated: true, isLoading: false };
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    const confirmButton = page.query("continuation-confirm-button");
    expect(confirmButton).not.toBeNull();
    (confirmButton as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The redemption POST carried the explicit confirmation flag.
    const confirmCall = chatFetch.mock.calls.find(([, init]) => {
      if (!init || typeof (init as RequestInit).body !== "string") {
        return false;
      }
      try {
        const body = JSON.parse((init as RequestInit).body as string);
        return body.confirmPlatformLink === true;
      } catch {
        return false;
      }
    });
    expect(confirmCall).toBeDefined();

    // Terminal state prompts back to Discord — no web chat.
    expect(page.query("continuation-done")).not.toBeNull();
    expect(page.html()).toContain("Head back to Discord");
    expect(page.query("continuation-open-discord")).not.toBeNull();

    page.unmount();
  });

  test("a Telegram continuation confirms and returns to the Telegram bot", async () => {
    authState = { isAuthenticated: true, isLoading: false };
    previewResult = {
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "shadow_tg",
    };
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    expect(page.html()).toContain("Connect your Telegram account?");
    expect(page.html()).toContain("Telegram ID 123456789");
    (page.query("continuation-confirm-button") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(page.html()).toContain("Head back to Telegram");
    const openTelegram = page.query("continuation-open-telegram");
    expect(openTelegram).not.toBeNull();
    expect(openTelegram?.getAttribute("href")).toContain("https://t.me/");
    page.unmount();
  });

  test("a non-Discord continuation falls back to the provisioning chat", async () => {
    authState = { isAuthenticated: true, isLoading: false };
    previewResult = null; // preview rejects (e.g. phone-originated session)
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    expect(page.query("continuation-confirm")).toBeNull();
    // Fallback mounts the provisioning chat, which fires its POST.
    const chatPost = chatFetch.mock.calls.find(
      ([, init]) => typeof (init as RequestInit)?.body === "string",
    );
    expect(chatPost).toBeDefined();

    page.unmount();
  });

  test("a transient preview failure stays on the continuation and retries", async () => {
    authState = { isAuthenticated: true, isLoading: false };
    previewError = new Error("elizacloud API error 503: upstream unavailable");
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    expect(page.query("continuation-error")).not.toBeNull();
    expect(
      chatFetch.mock.calls.some(
        ([, init]) => typeof (init as RequestInit)?.body === "string",
      ),
    ).toBe(false);
    previewError = null;
    const retryButton = page
      .query("continuation-error")
      ?.querySelector("button");
    expect(retryButton).not.toBeNull();
    (retryButton as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(page.query("continuation-confirm")).not.toBeNull();

    page.unmount();
  });

  test("a consent-denied Discord return restores the stashed continuation", async () => {
    const oauthState = "oauth-state-from-redirect";
    const sessionId = "0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111";
    const page = await renderPage(
      `/get-started?error=access_denied&state=${oauthState}`,
      (storage) => {
        storage.setItem("eliza_discord_oauth_state", oauthState);
        storage.setItem("eliza_onboarding_session_continuation", sessionId);
      },
    );

    expect(page.html()).toContain(SIGN_IN_HEADER);
    expect(page.html()).not.toContain(PICKER_HEADER);
    page.unmount();
  });

  test("no onboardingSession keeps the connector picker for organic visitors", async () => {
    const page = await renderPage("/get-started");

    expect(page.html()).toContain(PICKER_HEADER);
    expect(page.html()).not.toContain(SIGN_IN_HEADER);

    page.unmount();
  });
});
