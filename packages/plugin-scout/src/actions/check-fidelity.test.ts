import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { checkFidelityAction } from "./check-fidelity.js";
import { setScoutClient } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import type { FidelityResponse } from "../client/types.js";
import { ScoutApiError } from "../client/scout-client.js";

function makeMessage(text: string): Memory {
  return {
    content: { text },
    userId: "user-1",
    agentId: "agent-1",
    roomId: "room-1",
  } as Memory;
}

function makeRuntime(): IAgentRuntime {
  return { agentId: "agent-1" } as unknown as IAgentRuntime;
}

function makeFidelityResponse(overrides: Partial<FidelityResponse> = {}): FidelityResponse {
  return {
    success: true,
    domain: "test.com",
    endpointUrl: "https://test.com/api",
    fidelityScore: 85,
    level: "HIGH",
    layers: {
      protocolCompliance: { score: 90 },
      contractConsistency: { score: 80 },
      responseStructure: { score: 85 },
    },
    flags: [],
    checkDurationMs: 1200,
    checksTotal: 5,
    lastChecked: "2026-02-16T00:00:00Z",
    _meta: { cached: false, tier: "free", dataSource: "bazaar", checkedAt: "" },
    ...overrides,
  };
}

describe("checkFidelityAction", () => {
  describe("validate", () => {
    const runtime = makeRuntime();

    it("returns true for verify keyword + domain", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage("verify test.com service"))).toBe(true);
    });

    it("returns true for protocol keyword + domain", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage("does api.test.com follow the protocol?"))).toBe(true);
    });

    it("returns true for x402 keyword + domain", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage("x402 compliance check for test.com"))).toBe(true);
    });

    it("returns true for verify keyword + domain", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage("verify test.com service"))).toBe(true);
    });

    it("returns false when no fidelity keyword", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage("check test.com"))).toBe(false);
    });

    it("returns false when no domain", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage("check fidelity"))).toBe(false);
    });

    it("returns false for empty message", async () => {
      expect(await checkFidelityAction.validate(runtime, makeMessage(""))).toBe(false);
    });
  });

  describe("handler", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getServiceFidelity: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getServiceFidelity: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("returns formatted fidelity report", async () => {
      mockClient.getServiceFidelity.mockResolvedValue(makeFidelityResponse());
      const callback = vi.fn();

      const result = await checkFidelityAction.handler(
        runtime, makeMessage("check fidelity of test.com"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: true, data: expect.any(Object) });
      const text = callback.mock.calls[0][0].text;
      expect(text).toContain("Fidelity Report for test.com");
      expect(text).toContain("85/100");
      expect(text).toContain("Protocol Compliance: 90/100");
      expect(text).toContain("Contract Consistency: 80/100");
      expect(text).toContain("Response Structure: 85/100");
      expect(text).toContain("**Total Checks**: 5");
    });

    it("shows flags when present", async () => {
      mockClient.getServiceFidelity.mockResolvedValue(
        makeFidelityResponse({ flags: ["SCHEMA_PHANTOM", "PRICE_DRIFT"] })
      );
      const callback = vi.fn();

      await checkFidelityAction.handler(
        runtime, makeMessage("check fidelity of test.com"), undefined, undefined, callback
      );
      const text = callback.mock.calls[0][0].text;
      expect(text).toContain("SCHEMA_PHANTOM");
      expect(text).toContain("PRICE_DRIFT");
    });

    it("detects fresh keyword and passes fresh=true", async () => {
      mockClient.getServiceFidelity.mockResolvedValue(makeFidelityResponse());
      const callback = vi.fn();

      await checkFidelityAction.handler(
        runtime, makeMessage("do a fresh fidelity probe on test.com"), undefined, undefined, callback
      );

      expect(mockClient.getServiceFidelity).toHaveBeenCalledWith("test.com", true);
      expect(callback.mock.calls[0][0].text).toContain("Fresh probe performed");
    });

    it("detects force keyword for fresh probe", async () => {
      mockClient.getServiceFidelity.mockResolvedValue(makeFidelityResponse());

      await checkFidelityAction.handler(
        runtime, makeMessage("force fidelity check test.com"), undefined, undefined, vi.fn()
      );

      expect(mockClient.getServiceFidelity).toHaveBeenCalledWith("test.com", true);
    });

    it("passes fresh=false when no fresh keyword", async () => {
      mockClient.getServiceFidelity.mockResolvedValue(makeFidelityResponse());

      await checkFidelityAction.handler(
        runtime, makeMessage("check fidelity of test.com"), undefined, undefined, vi.fn()
      );

      expect(mockClient.getServiceFidelity).toHaveBeenCalledWith("test.com", false);
    });

    it("handles 404 error", async () => {
      mockClient.getServiceFidelity.mockRejectedValue(new ScoutApiError("Not found", 404));
      const callback = vi.fn();

      const result = await checkFidelityAction.handler(
        runtime, makeMessage("fidelity check test.com"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("not found");
    });

    it("handles 422 error (no endpoint)", async () => {
      mockClient.getServiceFidelity.mockRejectedValue(new ScoutApiError("No endpoint", 422));
      const callback = vi.fn();

      const result = await checkFidelityAction.handler(
        runtime, makeMessage("fidelity check test.com"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("no endpoint URL");
    });

    it("handles generic error", async () => {
      mockClient.getServiceFidelity.mockRejectedValue(new Error("Network fail"));
      const callback = vi.fn();

      const result = await checkFidelityAction.handler(
        runtime, makeMessage("fidelity check test.com"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("Fidelity check failed");
    });

    it("returns failure when no domain found", async () => {
      const callback = vi.fn();
      const result = await checkFidelityAction.handler(
        runtime, makeMessage("fidelity check something"), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
    });

    it("returns failure when client not initialized", async () => {
      const bareRuntime = makeRuntime();
      const callback = vi.fn();
      const result = await checkFidelityAction.handler(
        bareRuntime, makeMessage("fidelity check test.com"), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("not properly initialized");
    });
  });
});