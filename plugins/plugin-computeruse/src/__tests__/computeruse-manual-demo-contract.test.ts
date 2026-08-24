import { expect, it, vi } from "vitest";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  approveExactManualDemoAction,
  MANUAL_DEMO_FINGERPRINT,
} from "./computeruse-manual-demo-contract.js";

it("approves only the exact canonical browser action envelope", async () => {
  const parameters = {
    coordinate: [120, 112],
    action: "click",
  };
  const request = {
    id: "approval-fixture-browser-click",
    command: "browser_click",
    parameters: { action: "click", coordinate: [120, 112] },
    requestedAt: "2026-08-24T00:00:00.000Z",
  };
  const resolution = {
    id: request.id,
    command: request.command,
    approved: true,
    cancelled: false,
    mode: "approve_all" as const,
    requestedAt: request.requestedAt,
    resolvedAt: "2026-08-24T00:00:00.001Z",
    reason: MANUAL_DEMO_FINGERPRINT,
  };
  const resolveApproval = vi.fn(() => resolution);
  const service = {
    getApprovalSnapshot: () => ({
      mode: "approve_all",
      pendingCount: 1,
      pendingApprovals: [request],
    }),
    resolveApproval,
  } as unknown as ComputerUseService;

  await expect(
    approveExactManualDemoAction(service, "browser_click", parameters),
  ).resolves.toEqual({ request, resolution });
  expect(resolveApproval).toHaveBeenCalledWith(
    request.id,
    true,
    MANUAL_DEMO_FINGERPRINT,
  );
});
