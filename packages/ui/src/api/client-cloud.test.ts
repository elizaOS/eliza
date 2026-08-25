/** Verifies client-cloud's exported predicate/decoder surface — shared-agent base truth table, JWT expiry-decoding edges, API-base fallback branches, and the CloudAgentWakeError construction contract. */
// @vitest-environment jsdom

/**
 * Unit coverage for the exported pure helpers of the Cloud client module that
 * the per-feature sibling suites (client-cloud-*.test.ts) do not pin directly:
 * the full isDirectCloudSharedAgentBase truth table, the cloudTokenSecsRemaining
 * malformed-token and expired-token branches, resolveCloudAgentApiBase
 * whitespace/agentless edge inputs, and the CloudAgentWakeError field/context
 * contract. Hand-built tokens, deterministic, no network, additive only.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CloudAgentWakeError,
  cloudTokenSecsRemaining,
  isDirectCloudSharedAgentBase,
  resolveCloudAgentApiBase,
} from "./client-cloud";

function toBase64UrlSegment(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwtWithPayload(payloadJson: string): string {
  const header = toBase64UrlSegment(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  );
  return `${header}.${toBase64UrlSegment(payloadJson)}.sig`;
}

describe("isDirectCloudSharedAgentBase", () => {
  it("rejects null, undefined, and empty input", () => {
    expect(isDirectCloudSharedAgentBase(null)).toBe(false);
    expect(isDirectCloudSharedAgentBase(undefined)).toBe(false);
    expect(isDirectCloudSharedAgentBase("")).toBe(false);
  });

  it("accepts a shared REST adapter base scoped to an agent id", () => {
    expect(
      isDirectCloudSharedAgentBase(
        "https://api.eliza.app/api/v1/eliza/agents/agent-abc123",
      ),
    ).toBe(true);
  });

  it("accepts the legacy JSON-RPC /bridge suffix form", () => {
    expect(
      isDirectCloudSharedAgentBase(
        "https://api.eliza.app/api/v1/eliza/agents/agent-abc123/bridge",
      ),
    ).toBe(true);
  });

  it("tolerates trailing slashes on both forms", () => {
    expect(
      isDirectCloudSharedAgentBase(
        "https://api.eliza.app/api/v1/eliza/agents/agent-abc123/",
      ),
    ).toBe(true);
    expect(
      isDirectCloudSharedAgentBase(
        "https://api.eliza.app/api/v1/eliza/agents/agent-abc123/bridge/",
      ),
    ).toBe(true);
  });

  it("rejects the agent-id-less control-plane collection", () => {
    expect(
      isDirectCloudSharedAgentBase("https://api.eliza.app/api/v1/eliza/agents"),
    ).toBe(false);
  });

  it("rejects bare origins and unrelated app URLs", () => {
    expect(isDirectCloudSharedAgentBase("https://api.eliza.app")).toBe(false);
    expect(isDirectCloudSharedAgentBase("https://eliza.app/chat")).toBe(false);
  });
});

describe("cloudTokenSecsRemaining", () => {
  it("returns null for a token without three dot-separated segments", () => {
    const header = toBase64UrlSegment(JSON.stringify({ alg: "none" }));
    expect(cloudTokenSecsRemaining(`${header}.sig`)).toBeNull();
  });

  it("returns null when the payload segment is not valid base64", () => {
    const header = toBase64UrlSegment(JSON.stringify({ alg: "none" }));
    expect(
      cloudTokenSecsRemaining(`${header}.!!!not-base64!!!.sig`),
    ).toBeNull();
  });

  it("returns null when the payload decodes but is not JSON", () => {
    const header = toBase64UrlSegment(JSON.stringify({ alg: "none" }));
    const payload = btoa("definitely not json")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(cloudTokenSecsRemaining(`${header}.${payload}.sig`)).toBeNull();
  });

  it("returns null when exp is not a number (string exp)", () => {
    expect(
      cloudTokenSecsRemaining(
        makeJwtWithPayload(JSON.stringify({ exp: "900" })),
      ),
    ).toBeNull();
  });

  it("returns NEGATIVE seconds remaining for an expired token", () => {
    const exp = Math.floor(Date.now() / 1000) - 120;
    const secs = cloudTokenSecsRemaining(
      makeJwtWithPayload(JSON.stringify({ exp })),
    );
    expect(secs).not.toBeNull();
    expect(secs as number).toBeLessThan(0);
    expect(secs as number).toBeGreaterThan(-600);
  });

  it("decodes an unpadded base64url payload containing - and _ characters", () => {
    // "~~~~~~" forces '+' and '/' into the standard base64 of the JSON, so the
    // url-safe conversion below emits '-' and '_' — exercising the decoder's
    // inverse mapping rather than an alphabet-free round trip.
    const exp = Math.floor(Date.now() / 1000) + 30;
    const payloadJson = JSON.stringify({ sub: "~~~~~~", exp });
    const segment = toBase64UrlSegment(payloadJson);
    expect(segment).toContain("-");
    const secs = cloudTokenSecsRemaining(makeJwtWithPayload(payloadJson));
    expect(secs).not.toBeNull();
    expect(secs as number).toBeGreaterThan(20);
    expect(secs as number).toBeLessThanOrEqual(30);
  });
});

describe("resolveCloudAgentApiBase — whitespace and agentless edge inputs", () => {
  it("falls through a whitespace-only webUiUrl to the bridge URL", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: "https://bridge.example.internal/ws",
        webUiUrl: "   ",
      }),
    ).toBe("https://bridge.example.internal/ws");
  });

  it("trims surrounding whitespace from a usable webUiUrl", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: null,
        webUiUrl: "  https://agent-1.cloud.eliza.app  ",
      }),
    ).toBe("https://agent-1.cloud.eliza.app");
  });

  it("passes an agent-id-less control-plane collection through unchanged when neither agentId nor cloudApiBase can derive a replacement", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: "https://api.eliza.app/api/v1/eliza/agents",
        agentId: null,
        cloudApiBase: null,
      }),
    ).toBe("https://api.eliza.app/api/v1/eliza/agents");
  });
});

describe("CloudAgentWakeError construction contract", () => {
  it("defaults to the wake-failure code, ephemeral severity, and no optional fields", () => {
    const err = new CloudAgentWakeError({
      message: "Starting your cloud agent failed",
      phase: "resume",
      agentId: "agent-1",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ElizaError);
    expect(err.name).toBe("CloudAgentWakeError");
    expect(err.code).toBe("CLOUD_AGENT_WAKE_FAILED");
    expect(err.severity).toBe("ephemeral");
    expect(err.message).toBe("Starting your cloud agent failed");
    expect(err.phase).toBe("resume");
    expect(err.agentId).toBe("agent-1");
    expect(err.jobId).toBeUndefined();
    expect(err.status).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
    expect(err.lastObservedStatus).toBeUndefined();
  });

  it("carries correlation ids, HTTP status, Retry-After, and last observed status into fields and context", () => {
    const err = new CloudAgentWakeError({
      message: "Checking your cloud agent failed",
      phase: "status-poll",
      agentId: "agent-9",
      jobId: "job-7",
      status: 404,
      retryAfter: 12,
      lastObservedStatus: "provisioning",
    });
    expect(err.phase).toBe("status-poll");
    expect(err.agentId).toBe("agent-9");
    expect(err.jobId).toBe("job-7");
    expect(err.status).toBe(404);
    expect(err.retryAfter).toBe(12);
    expect(err.lastObservedStatus).toBe("provisioning");
    expect(err.context).toMatchObject({
      phase: "status-poll",
      agentId: "agent-9",
      jobId: "job-7",
      status: 404,
      retryAfter: 12,
      lastObservedStatus: "provisioning",
    });
  });

  it("honors a control-plane code override and preserves the cause chain", () => {
    const cause = new Error("control plane row gone");
    const err = new CloudAgentWakeError({
      message: "Provisioning your cloud agent failed",
      phase: "provision-job",
      agentId: "agent-2",
      jobId: "job-3",
      controlPlaneCode: "AGENT_NOT_FOUND",
      cause,
    });
    expect(err.code).toBe("AGENT_NOT_FOUND");
    expect(err.phase).toBe("provision-job");
    expect(err.jobId).toBe("job-3");
    expect(err.cause).toBe(cause);
  });
});
