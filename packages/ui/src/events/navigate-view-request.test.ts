/** Tests the bounded native-navigation replay boundary with real DOM events. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchNavigateViewRequest,
  listenForNavigateViewRequests,
} from "./index";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("native navigate-view requests", () => {
  it("replays a pre-listener request exactly once", () => {
    dispatchNavigateViewRequest({ viewPath: "/apps/deploy" });
    const received: Array<string | null | undefined> = [];
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
      }),
    );

    expect(received).toEqual(["/apps/deploy"]);
  });

  it("delivers a post-listener request without a later stale replay", () => {
    const received: Array<string | null | undefined> = [];
    const firstCleanup = listenForNavigateViewRequests((event) => {
      received.push(event.detail.viewPath);
    });
    cleanups.push(firstCleanup);

    dispatchNavigateViewRequest({ viewPath: "/settings" });
    expect(received).toEqual(["/settings"]);

    firstCleanup();
    cleanups.pop();
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
      }),
    );
    expect(received).toEqual(["/settings"]);
  });

  it("replays multiple cold-boot intents in delivery order", () => {
    dispatchNavigateViewRequest({ viewPath: "/wallet" });
    dispatchNavigateViewRequest({ viewPath: "/connectors" });
    const received: Array<string | null | undefined> = [];
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
      }),
    );

    expect(received).toEqual(["/wallet", "/connectors"]);
  });
});
