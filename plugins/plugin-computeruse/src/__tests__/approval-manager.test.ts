import { describe, expect, it, beforeEach } from "vitest";
import { ApprovalManager } from "../approval/approval-manager.ts";
import { DEFAULT_SAFE_COMMANDS } from "../approval/safe-commands.ts";

describe("ApprovalManager", () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  it("defaults to full_control and accepts valid modes", () => {
    expect(manager.getMode()).toBe("full_control");

    for (const mode of ["full_control", "smart_approve", "approve_all", "off"] as const) {
      manager.setMode(mode);
      expect(manager.getMode()).toBe(mode);
    }

    manager.setMode("full_control");
    manager.setMode("invalid_mode" as never);
    expect(manager.getMode()).toBe("full_control");
  });

  it("exposes the upstream safe-command allowlist", () => {
    expect(manager.getSafeCommands()).toEqual(DEFAULT_SAFE_COMMANDS);

    manager.setMode("smart_approve");
    for (const command of DEFAULT_SAFE_COMMANDS) {
      expect(manager.shouldAutoApprove(command)).toBe(true);
    }
  });

  it("full_control auto-approves everything without creating pending requests", async () => {
    manager.setMode("full_control");

    await expect(manager.requestApproval("click", { x: 10, y: 20 })).resolves.toMatchObject({
      approved: true,
      cancelled: false,
      mode: "full_control",
      command: "click",
    });

    expect(manager.getPendingCount()).toBe(0);
    expect(manager.shouldAutoApprove("terminal_execute")).toBe(true);
  });

  it("smart_approve auto-approves safe commands and queues unsafe ones", async () => {
    manager.setMode("smart_approve");

    await expect(manager.requestApproval("screenshot")).resolves.toMatchObject({
      approved: true,
      cancelled: false,
      mode: "smart_approve",
      command: "screenshot",
    });

    const pendingPromise = manager.requestApproval("file_write", { path: "/tmp/demo.txt" });
    expect(manager.getPendingCount()).toBe(1);

    const pending = manager.listPendingApprovals()[0];
    expect(pending).toMatchObject({
      command: "file_write",
      parameters: { path: "/tmp/demo.txt" },
    });

    const resolution = manager.resolvePendingApproval(pending.id, true, "approved by reviewer");
    expect(resolution).toMatchObject({
      approved: true,
      cancelled: false,
      mode: "smart_approve",
      reason: "approved by reviewer",
      command: "file_write",
    });

    await expect(pendingPromise).resolves.toMatchObject({
      approved: true,
      cancelled: false,
      mode: "smart_approve",
      reason: "approved by reviewer",
      command: "file_write",
    });

    expect(manager.getPendingCount()).toBe(0);
  });

  it("approve_all queues every command for manual review", async () => {
    manager.setMode("approve_all");

    const pendingPromise = manager.requestApproval("browser_get_dom");
    expect(manager.shouldAutoApprove("browser_get_dom")).toBe(false);
    expect(manager.getPendingCount()).toBe(1);

    const pending = manager.getPendingApproval("approval_1");
    expect(pending).toMatchObject({
      command: "browser_get_dom",
    });

    const resolution = manager.cancelPendingApproval("approval_1", "review declined");
    expect(resolution).toMatchObject({
      approved: false,
      cancelled: true,
      mode: "approve_all",
      reason: "review declined",
      command: "browser_get_dom",
    });

    await expect(pendingPromise).resolves.toMatchObject({
      approved: false,
      cancelled: true,
      mode: "approve_all",
      reason: "review declined",
      command: "browser_get_dom",
    });

    expect(manager.getPendingCount()).toBe(0);
  });

  it("off denies everything immediately", async () => {
    manager.setMode("off");

    await expect(manager.requestApproval("click")).resolves.toMatchObject({
      approved: false,
      cancelled: false,
      mode: "off",
      reason: "approval is disabled in off mode",
      command: "click",
    });

    expect(manager.isDenyAll()).toBe(true);
    expect(manager.getPendingCount()).toBe(0);
  });

  it("supports registering, resolving, and cancelling pending approvals directly", async () => {
    const pending = manager.registerPendingApproval("type", { text: "hello" });
    expect(manager.getPendingCount()).toBe(1);

    const listed = manager.listPendingApprovals();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      command: "type",
      parameters: { text: "hello" },
    });

    const cancelled = manager.cancelAllPendingApprovals("workspace closed");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      approved: false,
      cancelled: true,
      reason: "workspace closed",
      command: "type",
    });

    await expect(pending.promise).resolves.toMatchObject({
      approved: false,
      cancelled: true,
      reason: "workspace closed",
      command: "type",
    });

    expect(manager.getPendingCount()).toBe(0);

    expect(manager.resolvePendingApproval("missing", true)).toBeNull();
    expect(manager.cancelPendingApproval("missing")).toBeNull();
  });
});
