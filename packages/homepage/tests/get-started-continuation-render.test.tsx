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
 * - onboardingSession + authenticated still resumes the provisioning chat
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

// Network guard: the provisioning-chat hook must not reach the real API.
const chatFetch = mock(async () => ({
  success: true,
  data: {
    provisioning: { status: "pending", agentId: null, bridgeUrl: null },
    messages: [],
  },
}));
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
  Button: ({ children, ...rest }: { children?: unknown }) =>
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
  AppleMessagesIcon: passthrough,
  DiscordIcon: passthrough,
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

async function renderPage(url: string): Promise<{
  html: () => string;
  query: (testId: string) => Element | null;
  unmount: () => void;
}> {
  const window = setupDom();
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

  test("onboardingSession + authenticated resumes the provisioning chat", async () => {
    authState = { isAuthenticated: true, isLoading: false };
    const page = await renderPage(
      "/get-started?onboardingSession=0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111",
    );

    expect(page.html()).not.toContain(PICKER_HEADER);
    expect(page.html()).not.toContain(SIGN_IN_HEADER);
    // The provisioning chat hook fires its mount request.
    expect(chatFetch).toHaveBeenCalled();

    page.unmount();
  });

  test("no onboardingSession keeps the connector picker for organic visitors", async () => {
    const page = await renderPage("/get-started");

    expect(page.html()).toContain(PICKER_HEADER);
    expect(page.html()).not.toContain(SIGN_IN_HEADER);

    page.unmount();
  });
});
