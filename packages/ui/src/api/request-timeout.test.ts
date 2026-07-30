/**
 * Unit coverage for short-request deadlines and unbounded model operations.
 */
import { describe, expect, it } from "vitest";
import { defaultFetchTimeoutMs } from "./request-timeout";

describe("defaultFetchTimeoutMs", () => {
  it("does not impose a wall-clock cutoff on local neural TTS", () => {
    expect(
      defaultFetchTimeoutMs("http://127.0.0.1:31337/api/tts/local-inference", {
        method: "POST",
      }),
    ).toBeUndefined();
  });

  it("does not cut off in-process runtime shutdown", () => {
    expect(
      defaultFetchTimeoutMs("/api/agent/reset", {
        method: "POST",
      }),
    ).toBeUndefined();
  });

  it("leaves local-inference discovery under request ownership", () => {
    expect(
      defaultFetchTimeoutMs(
        "http://127.0.0.1:31337/api/local-inference/hub?refresh=1",
      ),
    ).toBeUndefined();
  });

  it("keeps ordinary API calls on the short default timeout", () => {
    expect(
      defaultFetchTimeoutMs("http://127.0.0.1:31337/api/health", {
        method: "GET",
      }),
    ).toBe(10_000);
  });
});
