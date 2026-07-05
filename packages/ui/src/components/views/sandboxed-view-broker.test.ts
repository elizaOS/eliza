// postMessage capability broker (#14180): deny-by-default over the iframe
// boundary. Pure logic — parses untrusted messages, checks grants, and returns
// typed denials without touching a facility when a capability is not granted.

import { resolveSurfaceManifest, type SurfaceManifest } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  brokerSandboxedViewRequest,
  parseSandboxedViewRequest,
  SANDBOXED_VIEW_CHANNEL,
  type SandboxedViewRequest,
} from "./sandboxed-view-broker";

const NAV_GRANT: SurfaceManifest = { capabilities: ["navigate"] };
const NO_GRANT: SurfaceManifest = { capabilities: [] };

function req(
  capability: string,
  payload?: unknown,
  requestId = "r1",
): SandboxedViewRequest {
  return {
    channel: SANDBOXED_VIEW_CHANNEL,
    kind: "request",
    requestId,
    capability: capability as SandboxedViewRequest["capability"],
    payload,
  };
}

function facilitySpies() {
  return {
    navigate: vi.fn(async () => ({ navigated: true })),
    storage: vi.fn(async () => ({ ok: true })),
  };
}

describe("parseSandboxedViewRequest", () => {
  it("accepts a well-formed navigate/storage request", () => {
    expect(
      parseSandboxedViewRequest({
        channel: SANDBOXED_VIEW_CHANNEL,
        kind: "request",
        requestId: "abc",
        capability: "navigate",
        payload: { viewId: "chat" },
      }),
    ).toEqual({
      channel: SANDBOXED_VIEW_CHANNEL,
      kind: "request",
      requestId: "abc",
      capability: "navigate",
      payload: { viewId: "chat" },
    });
  });

  it("rejects wrong channel, wrong kind, missing id, and non-brokered capability", () => {
    expect(parseSandboxedViewRequest(null)).toBeNull();
    expect(parseSandboxedViewRequest("nope")).toBeNull();
    expect(
      parseSandboxedViewRequest({
        channel: "other",
        kind: "request",
        requestId: "x",
        capability: "navigate",
      }),
    ).toBeNull();
    expect(
      parseSandboxedViewRequest({
        channel: SANDBOXED_VIEW_CHANNEL,
        kind: "response",
        requestId: "x",
        capability: "navigate",
      }),
    ).toBeNull();
    expect(
      parseSandboxedViewRequest({
        channel: SANDBOXED_VIEW_CHANNEL,
        kind: "request",
        requestId: "",
        capability: "navigate",
      }),
    ).toBeNull();
    // `wallpaper`/`agent-surface` are SurfaceCapabilities but NOT brokered here.
    expect(
      parseSandboxedViewRequest({
        channel: SANDBOXED_VIEW_CHANNEL,
        kind: "request",
        requestId: "x",
        capability: "wallpaper",
      }),
    ).toBeNull();
  });
});

describe("brokerSandboxedViewRequest", () => {
  it("DENIES navigate without the grant — the facility never runs", async () => {
    const facilities = facilitySpies();
    const res = await brokerSandboxedViewRequest(
      "v1",
      resolveSurfaceManifest({ surface: NO_GRANT }),
      req("navigate", { viewId: "chat" }),
      facilities,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not granted capability");
    expect(facilities.navigate).not.toHaveBeenCalled();
  });

  it("DENIES storage without the grant — the facility never runs", async () => {
    const facilities = facilitySpies();
    const res = await brokerSandboxedViewRequest(
      "v1",
      resolveSurfaceManifest({ surface: NAV_GRANT }),
      req("storage", { op: "set", key: "k", value: "v" }),
      facilities,
    );
    expect(res.ok).toBe(false);
    expect(facilities.storage).not.toHaveBeenCalled();
  });

  it("SERVICES a granted capability and returns its result", async () => {
    const facilities = facilitySpies();
    const res = await brokerSandboxedViewRequest(
      "v1",
      resolveSurfaceManifest({ surface: NAV_GRANT }),
      req("navigate", { viewId: "chat" }),
      facilities,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ navigated: true });
    expect(facilities.navigate).toHaveBeenCalledWith({ viewId: "chat" });
  });

  it("translates a facility throw into a typed failure frame (never a fake success)", async () => {
    const facilities = {
      navigate: vi.fn(async () => {
        throw new Error("bad payload");
      }),
      storage: vi.fn(async () => ({ ok: true })),
    };
    const res = await brokerSandboxedViewRequest(
      "v1",
      resolveSurfaceManifest({ surface: NAV_GRANT }),
      req("navigate", {}),
      facilities,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad payload");
  });
});
