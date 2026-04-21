import type {
  ApprovalManagerOptions,
  ApprovalMode,
  ApprovalRequest,
  ApprovalResolution,
  PendingApproval,
} from "./approval-types.js";
import { DEFAULT_SAFE_COMMAND_SET } from "./safe-commands.js";

interface PendingApprovalRecord extends PendingApproval {
  resolve: (resolution: ApprovalResolution) => void;
}

const VALID_MODES: readonly ApprovalMode[] = [
  "full_control",
  "smart_approve",
  "approve_all",
  "off",
];

export class ApprovalManager {
  private mode: ApprovalMode;

  private nextId = 0;

  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();

  constructor(options: ApprovalManagerOptions = {}) {
    this.mode = options.mode ?? "full_control";
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  setMode(mode: ApprovalMode): void {
    if (!VALID_MODES.includes(mode)) {
      return;
    }

    this.mode = mode;
  }

  isDenyAll(): boolean {
    return this.mode === "off";
  }

  getSafeCommands(): readonly string[] {
    return [...DEFAULT_SAFE_COMMAND_SET];
  }

  isSafeCommand(command: string): boolean {
    return DEFAULT_SAFE_COMMAND_SET.has(command);
  }

  shouldAutoApprove(command: string): boolean {
    switch (this.mode) {
      case "full_control":
        return true;
      case "smart_approve":
        return this.isSafeCommand(command);
      case "approve_all":
      case "off":
        return false;
    }
  }

  requestApproval(
    command: string,
    parameters: Record<string, unknown> = {},
  ): Promise<ApprovalResolution> {
    if (this.mode === "off") {
      return Promise.resolve(
        this.createImmediateResolution(
          command,
          parameters,
          false,
          "approval is disabled in off mode",
        ),
      );
    }

    if (this.shouldAutoApprove(command)) {
      const reason =
        this.mode === "full_control"
          ? "auto-approved in full_control mode"
          : "auto-approved by safe-command allowlist";
      return Promise.resolve(
        this.createImmediateResolution(command, parameters, true, reason),
      );
    }

    return this.registerPendingApproval(command, parameters).promise;
  }

  registerPendingApproval(
    command: string,
    parameters: Record<string, unknown> = {},
  ): PendingApproval {
    const request = this.createRequest(command, parameters);
    let resolvePromise: (resolution: ApprovalResolution) => void = () =>
      undefined;

    const promise = new Promise<ApprovalResolution>((resolve) => {
      resolvePromise = resolve;
    });

    this.pendingApprovals.set(request.id, {
      ...request,
      promise,
      resolve: resolvePromise,
    });

    return {
      ...request,
      promise,
    };
  }

  getPendingApproval(id: string): PendingApproval | undefined {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return undefined;
    }

    return this.clonePendingApproval(pending);
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].map((pending) =>
      this.clonePendingApproval(pending),
    );
  }

  resolvePendingApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): ApprovalResolution | null {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return null;
    }

    this.pendingApprovals.delete(id);

    const resolution = this.createResolution(pending, approved, false, reason);
    pending.resolve(resolution);
    return resolution;
  }

  cancelPendingApproval(
    id: string,
    reason = "cancelled",
  ): ApprovalResolution | null {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return null;
    }

    this.pendingApprovals.delete(id);

    const resolution = this.createResolution(pending, false, true, reason);
    pending.resolve(resolution);
    return resolution;
  }

  cancelAllPendingApprovals(reason = "cancelled"): ApprovalResolution[] {
    const ids = [...this.pendingApprovals.keys()];
    const resolutions: ApprovalResolution[] = [];

    for (const id of ids) {
      const resolution = this.cancelPendingApproval(id, reason);
      if (resolution) {
        resolutions.push(resolution);
      }
    }

    return resolutions;
  }

  getPendingCount(): number {
    return this.pendingApprovals.size;
  }

  private createRequest(
    command: string,
    parameters: Record<string, unknown>,
  ): ApprovalRequest {
    this.nextId += 1;

    return {
      id: `approval_${this.nextId}`,
      command,
      parameters: { ...parameters },
      requestedAt: new Date(),
    };
  }

  private createImmediateResolution(
    command: string,
    parameters: Record<string, unknown>,
    approved: boolean,
    reason?: string,
  ): ApprovalResolution {
    const request = this.createRequest(command, parameters);
    return this.createResolution(request, approved, false, reason);
  }

  private createResolution(
    request: ApprovalRequest,
    approved: boolean,
    cancelled: boolean,
    reason?: string,
  ): ApprovalResolution {
    return {
      ...request,
      approved,
      cancelled,
      mode: this.mode,
      resolvedAt: new Date(),
      reason,
    };
  }

  private clonePendingApproval(
    pending: PendingApprovalRecord,
  ): PendingApproval {
    return {
      id: pending.id,
      command: pending.command,
      parameters: { ...pending.parameters },
      requestedAt: new Date(pending.requestedAt),
      promise: pending.promise,
    };
  }
}
