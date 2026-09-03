/** Verifies privacy-safe browser chat correlation reduction and retry selection. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCloudLiveChatCorrelationCapture,
  parseCloudLiveChatCorrelation,
  requireDedicatedChatCorrelation,
  sanitizePreforward,
  sanitizeServerTiming,
} from "./cloud-live-chat-correlation";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const DEDICATED_TIMING =
  "dedicated_auth;dur=1.25, dedicated_ownership;dur=2, dedicated_routing;dur=3, dedicated_proxy_dispatch;dur=4, dedicated_total;dur=10.25";

describe("Cloud live chat correlation evidence", () => {
  it("retains only validated identifiers and canonical numeric timings", () => {
    expect(
      parseCloudLiveChatCorrelation({
        "x-eliza-trace-id": TRACE_ID,
        "server-timing": `private_api_key;dur=999, dedicated_auth;dur=1.250;desc="Bearer private", dedicated_ownership;dur=2, dedicated_routing;dur=3, dedicated_proxy_dispatch;dur=4, dedicated_total;dur=10.250, gateway_preforward;dur=5`,
        "x-eliza-preforward-ms": "total=5.0;auth=1;mid=2;reserve=1;setup=1",
        "x-eliza-provider-request-id": "req_cerebras-123.abc",
      }),
    ).toEqual({
      traceId: TRACE_ID,
      serverTiming: `${DEDICATED_TIMING}, gateway_preforward;dur=5`,
      preforward: "total=5;auth=1;mid=2;reserve=1;setup=1",
      providerRequestIdSha256: createHash("sha256")
        .update("req_cerebras-123.abc")
        .digest("hex"),
    });
  });

  it("drops arbitrary and malformed values instead of publishing them", () => {
    expect(
      sanitizeServerTiming('gateway_preforward;desc="private prompt"'),
    ).toBeNull();
    expect(sanitizeServerTiming("gateway_preforward;dur=Infinity")).toBeNull();
    expect(sanitizeServerTiming("secretBearerName;dur=12")).toBeNull();
    expect(sanitizePreforward("total=5;auth=1;mid=2;reserve=1")).toBeNull();
    expect(
      parseCloudLiveChatCorrelation({
        "x-eliza-trace-id": TRACE_ID.toUpperCase(),
        "x-eliza-provider-request-id": "Bearer private-secret",
      }),
    ).toBeNull();
    expect(
      parseCloudLiveChatCorrelation({
        "x-eliza-trace-id": TRACE_ID,
        "server-timing": "dedicated_total;dur=4",
      }),
    ).toBeNull();
    const secretShapedProviderId = [
      "Bearer",
      "private",
      "api",
      "key",
      "123",
    ].join("_");
    const hashed = parseCloudLiveChatCorrelation({
      "x-eliza-trace-id": TRACE_ID,
      "server-timing": DEDICATED_TIMING,
      "x-eliza-provider-request-id": secretShapedProviderId,
    });
    expect(hashed?.providerRequestIdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(hashed)).not.toContain(secretShapedProviderId);
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
      "server-timing": DEDICATED_TIMING,
    });
    expect(capture.requireSuccessful()).toEqual({
      traceId: TRACE_ID,
      serverTiming: DEDICATED_TIMING,
      preforward: null,
      providerRequestIdSha256: null,
      responseOrigin: "https://agent.example",
    });
  });

  it("binds the observed stream origin to the Dedicated reference API base", () => {
    const observation = {
      traceId: TRACE_ID,
      serverTiming: DEDICATED_TIMING,
      preforward: null,
      providerRequestIdSha256: null,
      responseOrigin: "https://agent.example",
    };
    expect(
      requireDedicatedChatCorrelation(
        { runtime: "dedicated", apiBase: "https://agent.example/" },
        observation,
      ),
    ).toEqual({
      traceId: TRACE_ID,
      serverTiming: DEDICATED_TIMING,
      preforward: null,
      providerRequestIdSha256: null,
    });
    expect(() =>
      requireDedicatedChatCorrelation(
        { runtime: "dedicated", apiBase: "https://other-agent.example" },
        observation,
      ),
    ).toThrow("did not match");
    expect(() =>
      requireDedicatedChatCorrelation(
        { runtime: "shared", apiBase: "https://agent.example" },
        observation,
      ),
    ).toThrow("did not match");
  });
});
