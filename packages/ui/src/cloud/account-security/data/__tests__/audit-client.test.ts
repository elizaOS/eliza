/**
 * Unit tests for client-side audit event emission.
 */
import { describe, expect, it, vi } from "vitest";
import * as apiClient from "../../../lib/api-client.ts";
import { emitAuditEvent } from "../audit-client.ts";

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

  it("handles ApiError or unexpected network failure by returning false without throwing", async () => {
    const apiFetchSpy = vi
      .spyOn(apiClient, "apiFetch")
      .mockRejectedValue(new Error("Network offline"));

    const success = await emitAuditEvent({
      action: "auth.session.revoke",
      result: "deny",
    });

    expect(success).toBe(false);
    apiFetchSpy.mockRestore();
  });
});
