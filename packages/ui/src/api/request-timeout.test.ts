import { describe, expect, it } from "vitest";
import { defaultFetchTimeoutMs } from "./request-timeout";

describe("defaultFetchTimeoutMs", () => {
  it("allows local neural TTS enough time for mobile CPU generation", () => {
    expect(
      defaultFetchTimeoutMs("http://127.0.0.1:31337/api/tts/local-inference", {
        method: "POST",
      }),
    ).toBe(180_000);
  });

  it("keeps ordinary API calls on the short default timeout", () => {
    expect(
      defaultFetchTimeoutMs("http://127.0.0.1:31337/api/health", {
        method: "GET",
      }),
    ).toBe(10_000);
  });
});
