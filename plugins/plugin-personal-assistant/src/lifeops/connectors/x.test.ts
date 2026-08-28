/**
 * X (Twitter) LifeOps connector contribution.
 *
 * Behavioral contracts pinned here:
 *  - `send()` rejects malformed payloads BEFORE touching the service (empty /
 *    whitespace targets, missing message, non-objects).
 *  - `send()` maps transport failures to typed DispatchResults and NEVER
 *    throws to the caller (429 -> rate_limited with retryAfterMinutes, etc.).
 *  - `status()` is crash-safe: even a hostile rejection value (e.g. a
 *    null-prototype object whose String() coercion throws) must yield a
 *    `disconnected` status instead of rejecting.
 */

import { LifeOpsServiceError } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createXConnectorContribution } from "./x";

const serviceState = vi.hoisted(() => ({
  getXConnectorStatus: vi.fn(),
  sendXDirectMessage: vi.fn(),
}));

vi.mock("../service.js", () => ({
  LifeOpsService: class {
    constructor(_runtime: unknown) {}
    getXConnectorStatus(...args: unknown[]) {
      return serviceState.getXConnectorStatus(...args);
    }
    sendXDirectMessage(...args: unknown[]) {
      return serviceState.sendXDirectMessage(...args);
    }
  },
}));

const RUNTIME = { agentId: "agent-1" };

describe("createXConnectorContribution", () => {
  let connector: ReturnType<typeof createXConnectorContribution>;

  beforeEach(() => {
    serviceState.getXConnectorStatus.mockReset();
    serviceState.sendXDirectMessage.mockReset();
    connector = createXConnectorContribution(RUNTIME as never);
  });

  describe("static surface", () => {
    it("declares x capabilities and local/cloud modes", () => {
      expect(connector.kind).toBe("x");
      expect(connector.capabilities).toEqual([
        "x.read",
        "x.write",
        "x.dm.read",
        "x.dm.write",
      ]);
      expect(connector.modes).toEqual(["local", "cloud"]);
    });

    it("start/disconnect are no-ops that resolve", async () => {
      await expect(connector.start()).resolves.toBeUndefined();
      await expect(connector.disconnect()).resolves.toBeUndefined();
    });
  });

  describe("verify", () => {
    it("resolves true when the service reports connected", async () => {
      serviceState.getXConnectorStatus.mockResolvedValue({ connected: true });
      await expect(connector.verify()).resolves.toBe(true);
      expect(serviceState.getXConnectorStatus).toHaveBeenCalledWith(
        undefined,
        "owner",
      );
    });

    it("resolves false when the service reports disconnected", async () => {
      serviceState.getXConnectorStatus.mockResolvedValue({ connected: false });
      await expect(connector.verify()).resolves.toBe(false);
    });
  });

  describe("status", () => {
    it("maps connected=true to ok", async () => {
      serviceState.getXConnectorStatus.mockResolvedValue({ connected: true });
      await expect(connector.status()).resolves.toMatchObject({
        state: "ok",
        observedAt: expect.any(String),
      });
    });

    it("maps connected with degradations to degraded", async () => {
      serviceState.getXConnectorStatus.mockResolvedValue({
        connected: true,
        degradations: [{ message: "X API degraded" }],
      });
      await expect(connector.status()).resolves.toMatchObject({
        state: "degraded",
        message: "X API degraded",
      });
    });

    it("maps connected=false to disconnected with the reason", async () => {
      serviceState.getXConnectorStatus.mockResolvedValue({
        connected: false,
        reason: "not linked",
      });
      await expect(connector.status()).resolves.toMatchObject({
        state: "disconnected",
        message: "not linked",
      });
    });

    it("never throws when the service throws a typed error", async () => {
      serviceState.getXConnectorStatus.mockRejectedValue(
        new LifeOpsServiceError("X unreachable", 503),
      );
      await expect(connector.status()).resolves.toMatchObject({
        state: "disconnected",
        message: "X unreachable",
      });
    });

    it("never throws when the service rejects with a hostile non-Error value", async () => {
      // Regression: the catch branch used formatError() directly, whose
      // String() coercion throws on null-prototype objects — turning a
      // status probe into a rejected promise instead of disconnected.
      const hostile = Object.create(null);
      serviceState.getXConnectorStatus.mockRejectedValue(hostile);
      await expect(connector.status()).resolves.toMatchObject({
        state: "disconnected",
        message: "[object Object]",
      });
    });
  });

  describe("send payload gate", () => {
    it.each([
      ["null", null],
      ["number", 42],
      ["empty object", {}],
      ["missing message", { target: "user-1" }],
      ["empty target", { target: "", message: "hi" }],
      ["whitespace target", { target: "   ", message: "hi" }],
      ["non-string target", { target: 7, message: "hi" }],
    ])("rejects %s before touching the service", async (_label, payload) => {
      const result = await connector.send(payload);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("transport_error");
      expect(serviceState.sendXDirectMessage).not.toHaveBeenCalled();
    });
  });

  describe("send success/failure mapping", () => {
    it("forwards a valid payload to the service and reports ok", async () => {
      serviceState.sendXDirectMessage.mockResolvedValue({ ok: true });
      const result = await connector.send({
        target: "user-1",
        message: "hello",
      });
      expect(result).toEqual({ ok: true });
      expect(serviceState.sendXDirectMessage).toHaveBeenCalledWith({
        participantId: "user-1",
        text: "hello",
        confirmSend: true,
        side: "owner",
      });
    });

    it("forwards an empty-string message per the current gate contract", async () => {
      // The payload gate requires target to be non-empty but only requires
      // message to be a string; an empty message is forwarded as-is.
      serviceState.sendXDirectMessage.mockResolvedValue({ ok: true });
      const result = await connector.send({
        target: "user-1",
        message: "",
      });
      expect(result).toEqual({ ok: true });
      expect(serviceState.sendXDirectMessage).toHaveBeenCalledWith({
        participantId: "user-1",
        text: "",
        confirmSend: true,
        side: "owner",
      });
    });

    it("maps a non-ok service response to transport_error", async () => {
      serviceState.sendXDirectMessage.mockResolvedValue({
        ok: false,
        error: "X DM send returned a non-ok response.",
      });
      const result = await connector.send({
        target: "user-1",
        message: "hello",
      });
      expect(result).toEqual({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message: "X DM send returned a non-ok response.",
      });
    });

    it("maps a 429 service error to rate_limited with retryAfterMinutes", async () => {
      serviceState.sendXDirectMessage.mockRejectedValue(
        new LifeOpsServiceError("rate limited", 429),
      );
      const result = await connector.send({
        target: "user-1",
        message: "hello",
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "rate_limited",
        retryAfterMinutes: 5,
        userActionable: false,
      });
    });

    it("maps a 401 service error to auth_expired and user-actionable", async () => {
      serviceState.sendXDirectMessage.mockRejectedValue(
        new LifeOpsServiceError("token expired", 401),
      );
      const result = await connector.send({
        target: "user-1",
        message: "hello",
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "auth_expired",
        userActionable: true,
      });
    });

    it("maps a generic service error to transport_error", async () => {
      serviceState.sendXDirectMessage.mockRejectedValue(
        new Error("socket hang up"),
      );
      const result = await connector.send({
        target: "user-1",
        message: "hello",
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message: "socket hang up",
      });
    });
  });
});
