import type {
  ApprovalMode,
  ApprovalResolution,
  ApprovalSnapshot,
  PendingApproval,
} from "./types.js";

const VALID_APPROVAL_MODES: ApprovalMode[] = [
  "full_control",
  "smart_approve",
  "approve_all",
  "off",
];

const SAFE_COMMANDS = new Set<string>([
  "screenshot",
  "browser_screenshot",
  "browser_state",
  "browser_dom",
  "browser_clickables",
  "browser_list_tabs",
  "list_windows",
]);

type ApprovalDecision = {
  approved: boolean;
  cancelled: boolean;
  reason?: string;
};

type PendingApprovalRecord = PendingApproval & {
  resolve: (result: ApprovalDecision) => void;
};

export function isApprovalMode(value: string): value is ApprovalMode {
  return VALID_APPROVAL_MODES.includes(value as ApprovalMode);
}

export class ComputerUseApprovalManager {
  private mode: ApprovalMode = "full_control";
  private pending = new Map<string, PendingApprovalRecord>();

  getMode(): ApprovalMode {
    return this.mode;
  }

  setMode(mode: string): ApprovalMode {
    if (isApprovalMode(mode)) {
      this.mode = mode;
    }
    return this.mode;
  }

  shouldAutoApprove(command: string): boolean {
    switch (this.mode) {
      case "full_control":
        return true;
      case "smart_approve":
        return SAFE_COMMANDS.has(command);
      case "approve_all":
      case "off":
        return false;
    }
  }

  isDenyAll(): boolean {
    return this.mode === "off";
  }

  requestApproval(
    command: string,
    parameters: Record<string, unknown> = {},
  ): Promise<ApprovalDecision> {
    const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const requestedAt = new Date().toISOString();

    return new Promise((resolve) => {
      this.pending.set(id, {
        id,
        command,
        parameters,
        requestedAt,
        resolve,
      });
    });
  }

  getSnapshot(): ApprovalSnapshot {
    return {
      mode: this.mode,
      pendingCount: this.pending.size,
      pendingApprovals: Array.from(this.pending.values()).map(
        ({ id, command, parameters, requestedAt }) => ({
          id,
          command,
          parameters,
          requestedAt,
        }),
      ),
    };
  }

  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): ApprovalResolution | null {
    const pending = this.pending.get(id);
    if (!pending) {
      return null;
    }

    this.pending.delete(id);
    pending.resolve({ approved, cancelled: false, reason });

    return {
      id: pending.id,
      command: pending.command,
      approved,
      cancelled: false,
      mode: this.mode,
      requestedAt: pending.requestedAt,
      resolvedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
  }

  cancelAll(reason?: string): void {
    for (const pending of this.pending.values()) {
      pending.resolve({ approved: false, cancelled: true, reason });
    }
    this.pending.clear();
  }
}
