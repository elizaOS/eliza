// @vitest-environment jsdom

import {
  dispatchNavigateViewRequest,
  listenForNavigateViewRequests,
  rejectNavigateViewRequest,
} from "@elizaos/ui/events";
import { navigateDeepLink } from "@elizaos/ui/state/notifications/navigate-deep-link";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveDeepLinkNavigationIntent } from "../deep-link-routing";
import {
  createMobileLifecycle,
  type DeepLinkApplicationResult,
} from "../mobile-lifecycle";

const native = vi.hoisted(() => ({
  listeners: [] as Array<(event: { url: string }) => void>,
  launch: null as string | null,
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (name: string, fn: (event: { url: string }) => void) => {
        if (name === "appUrlOpen") native.listeners.push(fn);
        return { remove: vi.fn() };
      },
    ),
    getLaunchUrl: vi.fn(async () => ({ url: native.launch })),
  },
}));
const target = {
  conversationId: "d13804ae-4156-47ba-abd1-12961448106e",
  messageId: "5fe90369-e521-4a28-adaa-c5f5688ee221",
};
const uri = `elizaos://chat?notificationId=630784a5-5f4e-47e7-88e9-162ac5bb7425&conversationId=${target.conversationId}&messageId=${target.messageId}`;
const stops: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  stops.splice(0).forEach((stop) => {
    stop();
  });
  const clear = listenForNavigateViewRequests(() => true);
  clear();
  native.listeners = [];
  native.launch = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function setup() {
  let pending: string | null = uri;
  const buffer = {
    peekPendingUrl: vi.fn(async () => ({ url: pending })),
    acknowledgePendingUrl: vi.fn(async () => {
      pending = null;
      return { cleared: true };
    }),
  };
  const dispatch = vi.fn(
    (value: string): undefined | Promise<DeepLinkApplicationResult> => {
      const parsed = new URL(value);
      const intent = resolveDeepLinkNavigationIntent(
        parsed.host,
        parsed.searchParams,
      );
      if (intent === false) return Promise.resolve({ rejected: true });
      if (!intent) return undefined;
      let rejected = false;
      return dispatchNavigateViewRequest(intent, {
        onRejected: () => {
          rejected = true;
        },
      }).then((applied) =>
        applied ? true : rejected ? ({ rejected: true } as const) : false,
      );
    },
  );
  native.launch = uri;
  const lifecycle = createMobileLifecycle({
    isNative: true,
    isAndroid: true,
    isIOS: false,
    logPrefix: "[native-source-test]",
    handleDeepLink: dispatch,
    androidDeepLinkBuffer: buffer,
  });
  lifecycle.initializeAppLifecycle();
  await lifecycle.initializeDeepLinks();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { buffer, dispatch };
}
it("retains exact native URI selectors and waits for the actual source owner before acknowledging", async () => {
  const { buffer, dispatch } = await setup();
  expect(buffer.acknowledgePendingUrl).not.toHaveBeenCalled();
  let complete: (value: boolean) => void = () => {};
  const result = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  const owner = vi.fn((event) => {
    expect(event.detail.payload).toEqual({ kind: "notification-chat", target });
    return result;
  });
  stops.push(listenForNavigateViewRequests(owner));
  expect(owner).toHaveBeenCalledOnce();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(buffer.acknowledgePendingUrl).not.toHaveBeenCalled();
  native.listeners.forEach((fn) => {
    fn({ url: uri });
  });
  // Android's genuine warm repeat remains a new admission; both await source application.
  expect(dispatch).toHaveBeenCalledTimes(2);
  complete(true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(buffer.acknowledgePendingUrl).toHaveBeenCalledWith({ url: uri });
});
it("consumes an authoritative foreign/missing source rejection without pretending it was applied", async () => {
  const { buffer } = await setup();
  stops.push(
    listenForNavigateViewRequests((event) =>
      Promise.resolve().then(() => {
        rejectNavigateViewRequest(event);
        return false;
      }),
    ),
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(buffer.acknowledgePendingUrl).toHaveBeenCalledOnce();
});
it("keeps transient rejection retryable and admits a duplicate Push callback through the same FIFO queue", async () => {
  const { buffer } = await setup();
  let available = false;
  const owner = vi.fn(() => Promise.resolve(available));
  stops.push(listenForNavigateViewRequests(owner));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(buffer.acknowledgePendingUrl).not.toHaveBeenCalled();
  available = true;
  const duplicate = navigateDeepLink("/chat", target);
  await expect(duplicate).resolves.toBe(true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(buffer.acknowledgePendingUrl).toHaveBeenCalledOnce();
  expect(owner).toHaveBeenCalledTimes(3);
});

it("keeps the native buffer for FIFO eviction instead of mislabeling it owner rejection", async () => {
  const { buffer } = await setup();
  for (let i = 0; i < 16; i++)
    void dispatchNavigateViewRequest({
      viewId: "unmounted-view",
      viewPath: `/unmounted-${i}`,
    });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(buffer.acknowledgePendingUrl).not.toHaveBeenCalled();
});
