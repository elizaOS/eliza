/** The pre-auth storm cap keeps a fixed ceiling on per-bearer buckets. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  __requestStormCapBucketCountForTests,
  __resetRequestStormCapForTests,
  maybeCapRequestStorm,
} from "./request-storm-cap.ts";

afterEach(() => {
  __resetRequestStormCapForTests();
});

function request(token: string): IncomingMessage {
  return {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: "203.0.113.5" },
  } as unknown as IncomingMessage;
}

describe("request storm cap", () => {
  it("keeps at most 4096 buckets under rotating bearers", () => {
    const res = {} as ServerResponse;
    for (let i = 0; i < 5000; i += 1) {
      expect(
        maybeCapRequestStorm(request(`rotating-${i}`), res, "/api/x"),
      ).toBe(false);
    }
    expect(__requestStormCapBucketCountForTests()).toBe(4096);
  });
});
