import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  "browser_info",
  "browser_get_dom",
  "browser_dom",
  "browser_get_clickables",
  "browser_clickables",
  "browser_get_context",
  "browser_list_tabs",
  "browser_wait",
  "file_read",
  "file_exists",
  "directory_list",
  "file_list_downloads",
  "file_download",
  "terminal_read",
  "terminal_connect",
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

type ApprovalListener = (snapshot: ApprovalSnapshot) => void;

export function isApprovalMode(value: string): value is ApprovalMode {
  return VALID_APPROVAL_MODES.includes(value as ApprovalMode);
}

export class ComputerUseApprovalManager {
  private mode: ApprovalMode = "full_control";
  private pending = new Map<string, PendingApprovalRecord>();
  private listeners = new Set<ApprovalListener>();
  private readonly configPath = path.join(
    os.homedir(),
    ".eliza",
    "computer-use-approval.json",
  );

  constructor() {
    this.loadConfig();
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  setMode(mode: string): ApprovalMode {
    if (isApprovalMode(mode)) {
      this.mode = mode;
      this.saveConfig();
      this.emit();
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
      this.emit();
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
    this.emit();

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
    this.emit();
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private loadConfig(): void {
    try {
      const raw = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as { mode?: unknown };
      if (typeof parsed.mode === "string" && isApprovalMode(parsed.mode)) {
        this.mode = parsed.mode;
      }
    } catch {
      // Keep the default mode when the config file is missing or invalid.
    }
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(
        this.configPath,
        JSON.stringify({ mode: this.mode }, null, 2),
        "utf8",
      );
    } catch {
      // Ignore persistence failures; approval mode still applies in-memory.
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
