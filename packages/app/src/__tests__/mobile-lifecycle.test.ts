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

function createAndroidDeepLinkBuffer(initialUrl: string | null) {
  let pendingUrl = initialUrl;
  return {
    peekPendingUrl: vi.fn(async () => ({ url: pendingUrl })),
    acknowledgePendingUrl: vi.fn(async ({ url }: { url: string }) => {
      const cleared = pendingUrl === url;
      if (cleared) pendingUrl = null;
      return { cleared };
    }),
  };
}

function createLifecycle(
  options: {
    platform?: "android" | "ios";
    androidDeepLinkBuffer?: ReturnType<typeof createAndroidDeepLinkBuffer>;
  } = {},
) {
  const platform = options.platform ?? "android";
  const handleDeepLink = vi.fn((_url: string) => undefined);
  const lifecycle = createMobileLifecycle({
    isNative: true,
    isIOS: platform === "ios",
    isAndroid: platform === "android",
    logPrefix: "[mobile-lifecycle-test]",
    handleDeepLink,
    androidDeepLinkBuffer: options.androidDeepLinkBuffer,
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

  it("iOS dedupes the cold-launch replay and its single appUrlOpen echo", async () => {
    const launch = "elizaos://assistant?source=ios-shortcut&action=ask";
    capacitorApp.launchUrl = launch;
    const { handleDeepLink } = createLifecycle({ platform: "ios" });
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

  it("Android applies a genuine repeat of the getLaunchUrl URL inside the replay window", async () => {
    // Android never echoes the launch intent through appUrlOpen; the next
    // identical appUrlOpen is a new onNewIntent tap and must apply.
    const launch = "elizaos://chat?source=android-widget&action=ask";
    capacitorApp.launchUrl = launch;
    const { handleDeepLink } = createLifecycle({ platform: "android" });
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(handleDeepLink).toHaveBeenCalledTimes(1);

    openWarmUrl(launch);
    expect(handleDeepLink).toHaveBeenCalledTimes(2);
    expect(handleDeepLink).toHaveBeenNthCalledWith(2, launch);
  });

  it("Android applies and acks a repeat of the buffered cold-launch URL inside the replay window", async () => {
    const launch = "elizaos://assistant?source=android-assist&action=ask";
    const buffer = createAndroidDeepLinkBuffer(launch);
    const { handleDeepLink } = createLifecycle({
      platform: "android",
      androidDeepLinkBuffer: buffer,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(handleDeepLink).toHaveBeenCalledTimes(1);
    expect(buffer.acknowledgePendingUrl).toHaveBeenCalledWith({ url: launch });

    openWarmUrl(launch);
    await flush();
    expect(handleDeepLink).toHaveBeenCalledTimes(2);
    expect(handleDeepLink).toHaveBeenNthCalledWith(2, launch);
  });
});
