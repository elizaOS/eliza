/**
 * ExecApprovalService
 *
 * Service for managing command execution approvals in plugin-shell.
 * Integrates with Eliza's ApprovalService for approval UI,
 * and provides allowlist management and command analysis.
 *
 * @example
 * ```typescript
 * const approvalService = runtime.getService('exec_approval') as ExecApprovalService;
 *
 * // Check if command needs approval
 * const check = await approvalService.checkCommand({
 *   command: 'rm -rf /tmp/cache',
 *   cwd: '/home/user',
 *   roomId: message.roomId,
 * });
 *
 * if (check.requiresApproval) {
 *   const result = await approvalService.requestApproval(check.request);
 *   if (result.decision === 'deny') {
 *     return { error: 'Command denied' };
 *   }
 *   if (result.decision === 'allow-always') {
 *     await approvalService.addToAllowlist(command);
 *   }
 * }
 * ```
 */

import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { type ApprovalService, logger, Service } from "@elizaos/core";

// Define our own approval options to avoid import issues
const EXEC_APPROVAL_OPTIONS: Array<{
  name: string;
  description: string;
  isCancel?: boolean;
}> = [
  { name: "allow-once", description: "Allow this one time" },
  { name: "allow-always", description: "Always allow this" },
  { name: "deny", description: "Deny the request", isCancel: true },
];

import {
  addAllowlistEntry,
  loadApprovals,
  recordAllowlistUse,
  resolveApprovals,
} from "./allowlist";
import {
  analyzeShellCommand,
  evaluateShellAllowlist,
  requiresExecApproval,
  resolveSafeBins,
} from "./analysis";
import type {
  ExecAllowlistEntry,
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResult,
  ExecApprovalsResolved,
  ExecAsk,
  ExecCommandAnalysis,
  ExecSecurity,
} from "./types";
import { EXEC_APPROVAL_DEFAULTS } from "./types";

/**
 * Command check result
 */
export interface CommandCheckResult {
  /** Whether the command can be executed */
  allowed: boolean;
  /** Whether approval is required */
  requiresApproval: boolean;
  /** Reason for denial (if not allowed and no approval needed) */
  reason?: string;
  /** Approval request (if approval required) */
  request?: ExecApprovalRequest;
  /** Command analysis result */
  analysis: ExecCommandAnalysis;
  /** Matching allowlist entries */
  allowlistMatches: ExecAllowlistEntry[];
}

/**
 * ExecApprovalService provides command execution approval management.
 */
export class ExecApprovalService extends Service {
  static serviceType = "exec_approval";
  capabilityDescription =
    "Manages command execution approvals with allowlist and user confirmation";

  private approvalConfig: ExecApprovalsResolved | null = null;
  private safeBins: Set<string>;
  private skillBins: Set<string>;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.safeBins = resolveSafeBins();
    this.skillBins = new Set();
  }

  /**
   * Start the ExecApprovalService
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new ExecApprovalService(runtime);

    // Load config - handle errors gracefully to not crash startup
    try {
      service.approvalConfig = resolveApprovals(runtime.agentId);
    } catch (error) {
      logger.error(
        { src: "service:exec_approval", error, agentId: runtime.agentId },
        "Failed to load approval config during startup - using in-memory defaults. " +
          "Approvals may not persist. Check file permissions for ~/.eliza/exec-approvals.json"
      );
      // Use a minimal in-memory config so the service can still function
      service.approvalConfig = {
        path: "",
        socketPath: "",
        token: "",
        defaults: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agent: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        allowlist: [],
        file: { version: 1, agents: {} },
      };
    }

    logger.info(
      { src: "service:exec_approval", agentId: runtime.agentId },
      "ExecApprovalService started"
    );
    return service;
  }

  /**
   * Stop the ExecApprovalService
   */
  async stop(): Promise<void> {
    logger.debug({ src: "service:exec_approval" }, "ExecApprovalService stopped");
  }

  /**
   * Load/reload configuration
   */
  loadConfig(agentId?: string): ExecApprovalsResolved {
    this.approvalConfig = resolveApprovals(agentId ?? this.runtime?.agentId);
    return this.approvalConfig;
  }

  /**
   * Get current configuration
   */
  getConfig(): ExecApprovalsResolved {
    if (!this.approvalConfig) {
      this.approvalConfig = resolveApprovals(this.runtime?.agentId);
    }
    return this.approvalConfig;
  }

  /**
   * Set safe binaries that don't need approval
   */
  setSafeBins(bins: string[]): void {
    this.safeBins = resolveSafeBins(bins);
  }

  /**
   * Set skill binaries that are auto-allowed
   */
  setSkillBins(bins: string[]): void {
    this.skillBins = new Set(bins.map((b) => b.toLowerCase()));
  }

  /**
   * Check if a command is allowed to execute
   */
  async checkCommand(params: {
    command: string;
    cwd?: string;
    roomId: UUID;
    env?: NodeJS.ProcessEnv;
    agentId?: string;
  }): Promise<CommandCheckResult> {
    const config = this.getConfig();

    // Analyze the command
    const analysis = analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
    });

    if (!analysis.ok) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: analysis.reason ?? "Command analysis failed",
        analysis,
        allowlistMatches: [],
      };
    }

    // Evaluate against allowlist
    const evaluation = evaluateShellAllowlist({
      command: params.command,
      allowlist: config.allowlist,
      safeBins: this.safeBins,
      cwd: params.cwd,
      env: params.env,
      skillBins: this.skillBins,
      autoAllowSkills: config.agent.autoAllowSkills,
    });

    // Check security mode
    const security = config.agent.security;
    const ask = config.agent.ask;

    // Full security mode - always allow
    if (security === "full") {
      return {
        allowed: true,
        requiresApproval: false,
        analysis,
        allowlistMatches: evaluation.allowlistMatches,
      };
    }

    // Deny mode - always deny unless explicitly allowed
    if (security === "deny") {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Command execution is disabled",
        analysis,
        allowlistMatches: [],
      };
    }

    // Allowlist mode - check if command is in allowlist
    if (evaluation.allowlistSatisfied) {
      // Record usage (best-effort, don't fail command if recording fails)
      let recordingFailed = false;
      for (const match of evaluation.allowlistMatches) {
        const approvals = loadApprovals();
        const recorded = recordAllowlistUse(
          approvals,
          params.agentId ?? this.runtime?.agentId,
          match,
          params.command,
          analysis.segments[0]?.resolution?.resolvedPath
        );
        if (!recorded) {
          recordingFailed = true;
        }
      }

      if (recordingFailed) {
        logger.debug(
          { src: "service:exec_approval", command: params.command },
          "Some allowlist usage records failed to save - command will still proceed"
        );
      }

      return {
        allowed: true,
        requiresApproval: false,
        analysis,
        allowlistMatches: evaluation.allowlistMatches,
      };
    }

    // Check if we need to ask for approval
    const needsApproval = requiresExecApproval({
      ask,
      security,
      analysisOk: analysis.ok,
      allowlistSatisfied: evaluation.allowlistSatisfied,
    });

    if (!needsApproval) {
      // No approval configured, deny based on fallback
      const fallback = config.agent.askFallback;
      if (fallback === "deny") {
        return {
          allowed: false,
          requiresApproval: false,
          reason: "Command not in allowlist",
          analysis,
          allowlistMatches: [],
        };
      }
      // Fallback is 'full' - allow
      return {
        allowed: true,
        requiresApproval: false,
        analysis,
        allowlistMatches: [],
      };
    }

    // Build approval request
    const requestId = crypto.randomUUID();
    const request: ExecApprovalRequest = {
      id: requestId,
      command: params.command,
      cwd: params.cwd,
      security,
      ask,
      agentId: params.agentId ?? this.runtime?.agentId,
      resolvedPath: analysis.segments[0]?.resolution?.resolvedPath,
      roomId: params.roomId,
      timeoutMs: EXEC_APPROVAL_DEFAULTS.timeoutMs,
    };

    return {
      allowed: false,
      requiresApproval: true,
      request,
      analysis,
      allowlistMatches: [],
    };
  }

  /**
   * Request approval for a command
   */
  async requestApproval(request: ExecApprovalRequest): Promise<ExecApprovalResult> {
    const approvalService = this.runtime?.getService("approval") as ApprovalService | null;

    if (!approvalService) {
      logger.warn(
        { src: "service:exec_approval" },
        "ApprovalService not available, denying by default"
      );
      return {
        decision: "deny",
        timedOut: false,
      };
    }

    // Build description
    const descriptionLines = ["**Exec Approval Required**", "", `Command: \`${request.command}\``];

    if (request.cwd) {
      descriptionLines.push(`CWD: \`${request.cwd}\``);
    }
    if (request.resolvedPath) {
      descriptionLines.push(`Executable: \`${request.resolvedPath}\``);
    }

    const description = descriptionLines.join("\n");

    // Request approval via Eliza's task system
    const result = await approvalService.requestApproval({
      name: "EXEC_APPROVAL",
      description,
      roomId: request.roomId,
      options: EXEC_APPROVAL_OPTIONS,
      timeoutMs: request.timeoutMs ?? EXEC_APPROVAL_DEFAULTS.timeoutMs,
      timeoutDefault: "deny",
      tags: ["EXEC", request.id],
      metadata: {
        execRequest: {
          id: request.id,
          command: request.command,
          cwd: request.cwd,
          security: request.security,
          ask: request.ask,
          agentId: request.agentId,
          resolvedPath: request.resolvedPath,
        },
      },
    });

    const decision = mapOptionToDecision(result.selectedOption);

    // If allow-always, add to allowlist
    if (decision === "allow-always" && request.resolvedPath) {
      await this.addToAllowlist(request.resolvedPath, request.agentId);
    }

    return {
      decision,
      timedOut: result.timedOut,
      resolvedBy: result.resolvedBy,
    };
  }

  /**
   * Request approval asynchronously (fire and forget with callbacks)
   */
  async requestApprovalAsync(
    request: ExecApprovalRequest,
    callbacks?: {
      onApproved?: (decision: ExecApprovalDecision) => Promise<void>;
      onDenied?: () => Promise<void>;
      onTimeout?: () => Promise<void>;
    }
  ): Promise<UUID> {
    const approvalService = this.runtime?.getService("approval") as ApprovalService | null;

    if (!approvalService) {
      logger.warn({ src: "service:exec_approval" }, "ApprovalService not available");
      if (callbacks?.onDenied) {
        await callbacks.onDenied();
      }
      throw new Error("ApprovalService not available");
    }

    const descriptionLines = ["**Exec Approval Required**", "", `Command: \`${request.command}\``];

    if (request.cwd) {
      descriptionLines.push(`CWD: \`${request.cwd}\``);
    }

    const taskId = await approvalService.requestApprovalAsync({
      name: "EXEC_APPROVAL",
      description: descriptionLines.join("\n"),
      roomId: request.roomId,
      options: EXEC_APPROVAL_OPTIONS,
      timeoutMs: request.timeoutMs ?? EXEC_APPROVAL_DEFAULTS.timeoutMs,
      timeoutDefault: "deny",
      tags: ["EXEC", request.id],
      metadata: {
        execRequest: {
          id: request.id,
          command: request.command,
          cwd: request.cwd,
          security: request.security,
          ask: request.ask,
          agentId: request.agentId,
          resolvedPath: request.resolvedPath,
        },
      },
      onSelect: async (option: string, _task: Task, _rt: IAgentRuntime) => {
        const decision = mapOptionToDecision(option);

        // If allow-always, add to allowlist
        if (decision === "allow-always" && request.resolvedPath) {
          await this.addToAllowlist(request.resolvedPath, request.agentId);
        }

        if (decision === "allow-once" || decision === "allow-always") {
          if (callbacks?.onApproved) {
            await callbacks.onApproved(decision);
          }
        } else {
          if (callbacks?.onDenied) {
            await callbacks.onDenied();
          }
        }
      },
      onTimeout: async (_task: Task, _rt: IAgentRuntime) => {
        if (callbacks?.onTimeout) {
          await callbacks.onTimeout();
        } else if (callbacks?.onDenied) {
          await callbacks.onDenied();
        }
      },
    });

    return taskId;
  }

  /**
   * Add a pattern to the allowlist
   * @returns true if pattern was added successfully
   */
  async addToAllowlist(pattern: string, agentId?: string): Promise<boolean> {
    const approvals = loadApprovals();
    const added = addAllowlistEntry(approvals, agentId ?? this.runtime?.agentId, pattern);
    if (added) {
      // Reload config to pick up the new entry
      this.approvalConfig = null;
    }
    return added;
  }

  /**
   * Cancel a pending approval
   */
  async cancelApproval(taskId: UUID): Promise<void> {
    const approvalService = this.runtime?.getService("approval") as ApprovalService | null;

    if (approvalService) {
      await approvalService.cancelApproval(taskId);
    }
  }

  /**
   * Get all pending exec approvals for a room
   */
  async getPendingApprovals(roomId: UUID): Promise<ExecApprovalRequest[]> {
    if (!this.runtime) {
      logger.warn(
        { src: "service:exec_approval" },
        "Cannot get pending approvals - runtime not available"
      );
      return [];
    }

    try {
      const tasks = await this.runtime.getTasks({
        roomId,
        tags: ["AWAITING_CHOICE", "EXEC"],
        agentIds: [this.runtime.agentId],
      });

      if (!tasks) return [];

      return tasks
        .filter((t) => t.metadata?.execRequest)
        .map((t) => {
          const execRequest = t.metadata?.execRequest as Record<string, unknown>;
          return {
            id: execRequest.id as string,
            command: execRequest.command as string,
            cwd: execRequest.cwd as string | undefined,
            security: execRequest.security as ExecSecurity | undefined,
            ask: execRequest.ask as ExecAsk | undefined,
            agentId: execRequest.agentId as string | undefined,
            resolvedPath: execRequest.resolvedPath as string | undefined,
            roomId,
          };
        });
    } catch (error) {
      logger.error(
        { src: "service:exec_approval", error, roomId },
        "Failed to get pending approvals"
      );
      return [];
    }
  }
}

/**
 * Map approval option to exec decision
 */
function mapOptionToDecision(option: string): ExecApprovalDecision {
  switch (option) {
    case "allow-once":
      return "allow-once";
    case "allow-always":
      return "allow-always";
    default:
      return "deny";
  }
}

export default ExecApprovalService;
