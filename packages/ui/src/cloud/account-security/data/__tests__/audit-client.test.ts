/**
 * Unit tests for client-side audit event emission.
 * Validates payload construction, POST to /api/v1/security/audit, successful boolean return,
 * and error-policy J7 diagnostic warning logging on delivery failure.
 */
import { logger } from "@elizaos/logger";
import { describe, expect, it, vi } from "vitest";
import * as apiClient from "../../../lib/api-client.js";
import { emitAuditEvent } from "../audit-client.js";

describe("audit-client", () => {
  it("emits audit payload via POST to /api/v1/security/audit and returns true on success", async () => {
    const apiFetchSpy = vi
      .spyOn(apiClient, "apiFetch")
      .mockResolvedValue({} as never);

    const success = await emitAuditEvent({
      action: "plugin.install",
      result: "allow",
      resource: { type: "plugin", id: "plugin-browser" },
      metadata: { source: "store" },
    });

    expect(success).toBe(true);
    expect(apiFetchSpy).toHaveBeenCalledWith("/api/v1/security/audit", {
      method: "POST",
      json: {
        action: "plugin.install",
        result: "allow",
        resource: { type: "plugin", id: "plugin-browser" },
        metadata: { source: "store" },
      },
    });

    apiFetchSpy.mockRestore();
  });

  it("handles ApiError or unexpected network failure by logging diagnostic warning and returning false", async () => {
    const apiFetchSpy = vi
      .spyOn(apiClient, "apiFetch")
      .mockRejectedValue(new Error("Network offline"));
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const success = await emitAuditEvent({
      action: "auth.session.revoke",
      result: "deny",
    });

    expect(success).toBe(false);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.session.revoke" }),
      "[audit-client] audit event delivery failed",
    );

    apiFetchSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });
});
