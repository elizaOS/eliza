/** Verifies privacy-safe browser chat correlation reduction and retry selection. */

import { describe, expect, it } from "vitest";
import {
  createCloudLiveChatCorrelationCapture,
  parseCloudLiveChatCorrelation,
  sanitizePreforward,
  sanitizeServerTiming,
} from "./cloud-live-chat-correlation";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

describe("Cloud live chat correlation evidence", () => {
  it("retains only validated identifiers and canonical numeric timings", () => {
    expect(
      parseCloudLiveChatCorrelation({
        "x-eliza-trace-id": TRACE_ID,
        "server-timing":
          'dedicated_auth;dur=1.250;desc="Bearer private", gateway;dur=42',
        "x-eliza-preforward-ms": "total=5.0;auth=1;mid=2;reserve=1;setup=1",
        "x-eliza-provider-request-id": "req_cerebras-123.abc",
      }),
    ).toEqual({
      traceId: TRACE_ID,
      serverTiming: "dedicated_auth;dur=1.25, gateway;dur=42",
      preforward: "total=5;auth=1;mid=2;reserve=1;setup=1",
      providerRequestId: "req_cerebras-123.abc",
    });
  });

  it("drops arbitrary and malformed values instead of publishing them", () => {
    expect(sanitizeServerTiming('gateway;desc="private prompt"')).toBeNull();
    expect(sanitizeServerTiming("gateway;dur=Infinity")).toBeNull();
    expect(sanitizePreforward("total=5;auth=1;mid=2;reserve=1")).toBeNull();
    expect(
      parseCloudLiveChatCorrelation({
        "x-eliza-trace-id": TRACE_ID.toUpperCase(),
        "x-eliza-provider-request-id": "Bearer private-secret",
      }),
    ).toBeNull();
  });

  it("binds evidence to the latest successful stream after a warming retry", () => {
    const capture = createCloudLiveChatCorrelationCapture();
    const endpoint =
      "https://agent.example/api/conversations/private/messages/stream";
    capture.observe("POST", endpoint, 503, {
      "x-eliza-trace-id": "a".repeat(32),
    });
    capture.observe("GET", endpoint, 200, {
      "x-eliza-trace-id": "b".repeat(32),
    });
    expect(() => capture.requireSuccessful()).toThrow("lacked a valid trace");
    capture.observe("POST", endpoint, 200, {
      "x-eliza-trace-id": TRACE_ID,
      "server-timing": "dedicated_total;dur=4",
    });
    expect(capture.requireSuccessful()).toEqual({
      traceId: TRACE_ID,
      serverTiming: "dedicated_total;dur=4",
      preforward: null,
      providerRequestId: null,
    });
  });
});
