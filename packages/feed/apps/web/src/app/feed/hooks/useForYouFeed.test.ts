import { describe, expect, it } from "bun:test";
import {
  getForYouFeedSseChannel,
  shouldStartInitialForYouFetch,
} from "./useForYouFeed";

describe("useForYouFeed auth readiness guards", () => {
  it("waits for auth readiness before the initial fetch", () => {
    expect(
      shouldStartInitialForYouFetch({
        enabled: true,
        authReady: false,
        hasFetched: false,
      }),
    ).toBe(false);
  });

  it("starts the initial fetch once auth is ready", () => {
    expect(
      shouldStartInitialForYouFetch({
        enabled: true,
        authReady: true,
        hasFetched: false,
      }),
    ).toBe(true);
  });

  it("does not re-run the initial fetch after it already started", () => {
    expect(
      shouldStartInitialForYouFetch({
        enabled: true,
        authReady: true,
        hasFetched: true,
      }),
    ).toBe(false);
  });

  it("subscribes to feed SSE only after auth is ready", () => {
    expect(getForYouFeedSseChannel(true, false)).toBeNull();
    expect(getForYouFeedSseChannel(false, true)).toBeNull();
    expect(getForYouFeedSseChannel(true, true)).toBe("feed");
  });
});
