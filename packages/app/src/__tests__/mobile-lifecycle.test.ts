import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UrlOpenListener = (event: { url: string }) => void;

const capacitorApp = vi.hoisted(() => ({
  urlOpenListeners: [] as Array<(event: { url: string }) => void>,
  launchUrl: null as string | null,
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: UrlOpenListener) => {
      if (event === "appUrlOpen") capacitorApp.urlOpenListeners.push(listener);
      return { remove: vi.fn() };
    }),
    getLaunchUrl: vi.fn(async () =>
      capacitorApp.launchUrl ? { url: capacitorApp.launchUrl } : undefined,
    ),
    minimizeApp: vi.fn(async () => {}),
  },
}));

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn() },
  KeyboardResize: { None: "none" },
}));

vi.mock("@elizaos/ui/components/shell/ios-chat-accessory-bar", () => ({
  initializeIosKeyboardAccessoryBar: vi.fn(async () => {}),
}));

vi.mock("@elizaos/ui/platform", () => ({
  isStandalonePwa: () => false,
}));

vi.mock("@elizaos/ui/events", () => ({
  APP_PAUSE_EVENT: "app-pause",
  APP_RESUME_EVENT: "app-resume",
  NETWORK_STATUS_CHANGE_EVENT: "network-status-change",
  dispatchAppEvent: vi.fn(),
  dispatchBackIntent: vi.fn(() => false),
}));

import { createMobileLifecycle } from "../mobile-lifecycle";

function openWarmUrl(url: string): void {
  for (const listener of capacitorApp.urlOpenListeners) listener({ url });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function createLifecycle() {
  const handleDeepLink = vi.fn((_url: string) => undefined);
  const lifecycle = createMobileLifecycle({
    isNative: true,
    isIOS: false,
    isAndroid: true,
    logPrefix: "[mobile-lifecycle-test]",
    handleDeepLink,
  });
  lifecycle.initializeAppLifecycle();
  return { handleDeepLink };
}

describe("mobile lifecycle deep links", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capacitorApp.urlOpenListeners.length = 0;
    capacitorApp.launchUrl = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies every repeated identical warm appUrlOpen intent", async () => {
    const { handleDeepLink } = createLifecycle();
    await flush();
    const widgetAsk = "elizaos://chat?source=android-widget&action=ask";

    openWarmUrl(widgetAsk);
    openWarmUrl(widgetAsk);
    // Still repeated after the cold-launch replay window has closed.
    await vi.advanceTimersByTimeAsync(20_000);
    openWarmUrl(widgetAsk);

    expect(handleDeepLink).toHaveBeenCalledTimes(3);
    expect(handleDeepLink).toHaveBeenNthCalledWith(3, widgetAsk);
  });

  it("still dedupes the cold-launch replay and its single appUrlOpen echo", async () => {
    const launch = "elizaos://assistant?source=android-assist&action=ask";
    capacitorApp.launchUrl = launch;
    const { handleDeepLink } = createLifecycle();
    await flush();
    // getLaunchUrl keeps returning the launch URL every replay tick.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(handleDeepLink).toHaveBeenCalledTimes(1);

    // Capacitor's retained cold-launch appUrlOpen for the same URL is an echo.
    openWarmUrl(launch);
    expect(handleDeepLink).toHaveBeenCalledTimes(1);

    // A genuine later warm intent with the same URL applies.
    openWarmUrl(launch);
    expect(handleDeepLink).toHaveBeenCalledTimes(2);
  });
});
