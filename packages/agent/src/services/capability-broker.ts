/**
 * CapabilityBroker — single decision point for privileged tool access.
 *
 * Every tool that touches a privileged resource (filesystem, shell, network,
 * camera, mic, location, screen, contacts, messages, health, browser, wallet)
 * calls `broker.check(req)` before doing the work. The broker consults a
 * static policy table keyed by `(runtime mode, distribution profile)` and
 * returns an allow/deny decision with a stable `policyKey` for auditing.
 *
 * Two orthogonal axes drive policy:
 *   1. RuntimeExecutionMode — `cloud` | `local-safe` | `local-yolo`
 *      Where computation lives and how trusted the local machine is. Cloud
 *      runtime never gets to touch native surfaces; local-safe routes
 *      shell/exec through the sandbox; local-yolo is the developer mode.
 *   2. DistributionProfile — `store` | `unrestricted`
 *      Which storefront the binary will be submitted to. Store builds must
 *      be containable inside Apple/Google/Microsoft sandbox guarantees, so
 *      arbitrary host-fs writes and raw shell exec are denied even in
 *      local-yolo. `unrestricted` is for direct-download / dev builds.
 *
 * Audit log lands at `<stateDir>/audit/capability.jsonl` as one JSON object
 * per check. Writes are synchronous so a crash mid-action still leaves a
 * record. The file is truncated at broker boot if it exceeds 50MB.
 */

import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import {
  type DistributionProfile,
  type RuntimeExecutionMode,
  resolveDistributionProfile,
} from "@elizaos/shared";
import { resolveStateDir } from "../config/paths.ts";

export type CapabilityKind =
  | "fs"
  | "shell"
  | "net"
  | "camera"
  | "mic"
  | "location"
  | "screen"
  | "contacts"
  | "messages"
  | "health"
  | "browser"
  | "wallet";

export type CapabilityOp =
  | "read"
  | "write"
  | "exec"
  | "connect"
  | "capture"
  | "list";

export interface CapabilityRequest {
  kind: CapabilityKind;
  op: CapabilityOp;
  target?: string;
  reason?: string;
  toolName?: string;
}

export type CapabilityDecision =
  | { allowed: true; policyKey: string }
  | { allowed: false; reason: string; policyKey: string };

export interface BrokerOptions {
  stateDir?: string;
  auditFilePath?: string;
  mode?: () => RuntimeExecutionMode;
  distributionProfile?: () => DistributionProfile;
  now?: () => Date;
}

export interface AuditedDecision {
  ts: string;
  kind: CapabilityKind;
  op: CapabilityOp;
  target: string | null;
  toolName: string | null;
  reason: string | null;
  allowed: boolean;
  denyReason: string | null;
  mode: RuntimeExecutionMode;
  profile: DistributionProfile;
  policyKey: string;
}

export interface BrokerSnapshot {
  mode: RuntimeExecutionMode;
  profile: DistributionProfile;
  auditFilePath: string;
  recent: AuditedDecision[];
}

const AUDIT_LOG_MAX_BYTES = 50 * 1024 * 1024;
const RECENT_DECISION_BUFFER = 256;

/**
 * Cloud egress allowlist. The cloud runtime is sandboxed so it cannot reach
 * arbitrary hosts; only the elizaOS Cloud control plane and inference
 * surfaces are reachable. Any host outside this list must be denied.
 */
const CLOUD_NET_ALLOWED_HOSTS: readonly string[] = [
  "elizacloud.ai",
  "api.elizacloud.ai",
  "www.elizacloud.ai",
];

/**
 * Tool-name prefix that signals a request is going through the local-safe
 * sandbox engine (Docker / Apple Container). Tools without this prefix are
 * touching the host directly, which `local-safe` mode forbids.
 */
const SANDBOX_TOOL_NAME_PREFIX = "sandbox.";

type StaticDecision = "allow" | "deny";

interface PolicyResult {
  allow: boolean;
  reason: string | null;
}

type PolicyResolver = (req: CapabilityRequest) => PolicyResult;

type PolicyEntry = StaticDecision | PolicyResolver;

type OpPolicy = Partial<Record<CapabilityOp, PolicyEntry>>;

type KindPolicy = Partial<Record<CapabilityKind, OpPolicy>>;

type ProfilePolicy = Record<DistributionProfile, KindPolicy>;

type RuntimePolicy = Record<RuntimeExecutionMode, ProfilePolicy>;

const ALLOW: PolicyResult = { allow: true, reason: null };

function deny(reason: string): PolicyResult {
  return { allow: false, reason };
}

function isHostFsTarget(target: string | undefined): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  // VFS targets are expressed as virtual paths: scheme `vfs://` or relative.
  // Anything starting with `/`, `~`, or a drive letter is a host path.
  if (target.startsWith("vfs://")) return false;
  return (
    target.startsWith("/") ||
    target.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(target)
  );
}

function isCloudAllowedHost(target: string | undefined): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    host = target.toLowerCase();
  }
  return CLOUD_NET_ALLOWED_HOSTS.includes(host);
}

function isSandboxedTool(toolName: string | undefined): boolean {
  return (
    typeof toolName === "string" &&
    toolName.startsWith(SANDBOX_TOOL_NAME_PREFIX)
  );
}

const fsHostWriteSandboxed: PolicyResolver = (req) =>
  isHostFsTarget(req.target)
    ? deny("Host filesystem writes require VFS targets in this profile")
    : ALLOW;

const fsHostWriteHardDenied: PolicyResolver = (req) =>
  isHostFsTarget(req.target)
    ? deny(
        "Cloud runtime cannot touch host filesystem; route through VFS or Cloud APIs",
      )
    : ALLOW;

const cloudNetConnect: PolicyResolver = (req) =>
  isCloudAllowedHost(req.target)
    ? ALLOW
    : deny(
        `Cloud runtime can only reach allowlisted hosts: ${CLOUD_NET_ALLOWED_HOSTS.join(", ")}`,
      );

const sandboxedShell: PolicyResolver = (req) =>
  isSandboxedTool(req.toolName)
    ? ALLOW
    : deny(
        "local-safe denies host shell exec; invoke via sandbox.* tools (Docker / Apple Container)",
      );

const POLICY: RuntimePolicy = {
  cloud: {
    store: cloudKindPolicy(),
    unrestricted: cloudKindPolicy(),
  },
  "local-safe": {
    store: localSafeStorePolicy(),
    unrestricted: localSafeUnrestrictedPolicy(),
  },
  "local-yolo": {
    store: localYoloStorePolicy(),
    unrestricted: localYoloUnrestrictedPolicy(),
  },
};

function cloudKindPolicy(): KindPolicy {
  return {
    fs: {
      read: fsHostWriteHardDenied,
      write: fsHostWriteHardDenied,
      list: fsHostWriteHardDenied,
    },
    shell: {
      exec: "deny",
    },
    net: {
      connect: cloudNetConnect,
    },
    camera: { capture: "deny" },
    mic: { capture: "deny" },
    location: { read: "deny" },
    screen: { capture: "deny" },
    contacts: { read: "deny", list: "deny" },
    messages: { read: "deny", write: "deny" },
    health: { read: "deny" },
    browser: { exec: "deny" },
    wallet: { read: "deny", write: "deny" },
  };
}

function localSafeStorePolicy(): KindPolicy {
  return {
    fs: {
      read: fsHostWriteSandboxed,
      write: fsHostWriteSandboxed,
      list: fsHostWriteSandboxed,
    },
    shell: {
      exec: sandboxedShell,
    },
    net: {
      connect: "allow",
    },
    camera: { capture: "allow" },
    mic: { capture: "allow" },
    location: { read: "allow" },
    screen: { capture: "deny" },
    contacts: { read: "allow", list: "allow" },
    messages: { read: "allow", write: "allow" },
    health: { read: "allow" },
    browser: { exec: "allow" },
    wallet: { read: "allow", write: "deny" },
  };
}

function localSafeUnrestrictedPolicy(): KindPolicy {
  return {
    fs: {
      read: "allow",
      write: fsHostWriteSandboxed,
      list: "allow",
    },
    shell: {
      exec: sandboxedShell,
    },
    net: { connect: "allow" },
    camera: { capture: "allow" },
    mic: { capture: "allow" },
    location: { read: "allow" },
    screen: { capture: "allow" },
    contacts: { read: "allow", list: "allow" },
    messages: { read: "allow", write: "allow" },
    health: { read: "allow" },
    browser: { exec: "allow" },
    wallet: { read: "allow", write: "allow" },
  };
}

function localYoloStorePolicy(): KindPolicy {
  return {
    fs: {
      read: fsHostWriteSandboxed,
      write: fsHostWriteSandboxed,
      list: fsHostWriteSandboxed,
    },
    shell: {
      exec: "deny",
    },
    net: { connect: "allow" },
    camera: { capture: "allow" },
    mic: { capture: "allow" },
    location: { read: "allow" },
    screen: { capture: "deny" },
    contacts: { read: "allow", list: "allow" },
    messages: { read: "allow", write: "allow" },
    health: { read: "allow" },
    browser: { exec: "allow" },
    wallet: { read: "allow", write: "deny" },
  };
}

function localYoloUnrestrictedPolicy(): KindPolicy {
  return {
    fs: { read: "allow", write: "allow", list: "allow" },
    shell: { exec: "allow" },
    net: { connect: "allow" },
    camera: { capture: "allow" },
    mic: { capture: "allow" },
    location: { read: "allow" },
    screen: { capture: "allow" },
    contacts: { read: "allow", list: "allow" },
    messages: { read: "allow", write: "allow" },
    health: { read: "allow" },
    browser: { exec: "allow" },
    wallet: { read: "allow", write: "allow" },
  };
}

function policyKeyFor(
  mode: RuntimeExecutionMode,
  profile: DistributionProfile,
  req: CapabilityRequest,
): string {
  return `${mode}:${profile}:${req.kind}:${req.op}`;
}

function evaluatePolicy(
  mode: RuntimeExecutionMode,
  profile: DistributionProfile,
  req: CapabilityRequest,
): PolicyResult {
  const opPolicy = POLICY[mode][profile][req.kind]?.[req.op];
  if (opPolicy === undefined) {
    return deny(
      `No policy entry for ${req.kind}.${req.op} in ${mode}/${profile}`,
    );
  }
  if (opPolicy === "allow") return ALLOW;
  if (opPolicy === "deny") {
    return deny(`${req.kind}.${req.op} is denied in ${mode}/${profile}`);
  }
  return opPolicy(req);
}

export class CapabilityBroker {
  private readonly auditFilePath: string;
  private readonly modeFn: () => RuntimeExecutionMode;
  private readonly profileFn: () => DistributionProfile;
  private readonly nowFn: () => Date;
  private readonly recent: AuditedDecision[] = [];

  constructor(options: BrokerOptions = {}) {
    const stateDir =
      options.stateDir ?? resolveStateDir(process.env, os.homedir);
    this.auditFilePath =
      options.auditFilePath ?? path.join(stateDir, "audit", "capability.jsonl");
    this.modeFn = options.mode ?? (() => "local-safe");
    this.profileFn = options.distributionProfile ?? resolveDistributionProfile;
    this.nowFn = options.now ?? (() => new Date());

    mkdirSync(path.dirname(this.auditFilePath), { recursive: true });
    this.rotateIfOversized();
  }

  check(req: CapabilityRequest): CapabilityDecision {
    const mode = this.modeFn();
    const profile = this.profileFn();
    const policyKey = policyKeyFor(mode, profile, req);
    const result = evaluatePolicy(mode, profile, req);
    let decision: CapabilityDecision;
    if (result.allow) {
      decision = { allowed: true, policyKey };
    } else {
      // Invariant: deny() always supplies a non-null reason. Surface a
      // structured error if a policy resolver violated that contract so the
      // bug fails loud instead of writing `null` into the audit log.
      if (result.reason === null) {
        throw new Error(
          `[CapabilityBroker] Policy resolver returned deny without a reason for ${policyKey}`,
        );
      }
      decision = { allowed: false, reason: result.reason, policyKey };
    }

    this.audit(req, decision, mode, profile, policyKey);
    return decision;
  }

  snapshot(): BrokerSnapshot {
    return {
      mode: this.modeFn(),
      profile: this.profileFn(),
      auditFilePath: this.auditFilePath,
      recent: [...this.recent],
    };
  }

  recentDecisions(limit = 50): AuditedDecision[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const start = Math.max(0, this.recent.length - Math.floor(limit));
    return this.recent.slice(start);
  }

  private rotateIfOversized(): void {
    let size: number;
    try {
      size = statSync(this.auditFilePath).size;
    } catch {
      return;
    }
    if (size > AUDIT_LOG_MAX_BYTES) {
      truncateSync(this.auditFilePath, 0);
      logger.info(
        `[CapabilityBroker] Truncated audit log at ${this.auditFilePath} (was ${size} bytes)`,
      );
    }
  }

  private audit(
    req: CapabilityRequest,
    decision: CapabilityDecision,
    mode: RuntimeExecutionMode,
    profile: DistributionProfile,
    policyKey: string,
  ): void {
    const denyReason: string | null =
      decision.allowed === true ? null : decision.reason;
    const record: AuditedDecision = {
      ts: this.nowFn().toISOString(),
      kind: req.kind,
      op: req.op,
      target: req.target ?? null,
      toolName: req.toolName ?? null,
      reason: req.reason ?? null,
      allowed: decision.allowed,
      denyReason,
      mode,
      profile,
      policyKey,
    };
    this.recent.push(record);
    if (this.recent.length > RECENT_DECISION_BUFFER) {
      this.recent.splice(0, this.recent.length - RECENT_DECISION_BUFFER);
    }
    try {
      appendFileSync(this.auditFilePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      // The audit boundary is the only place we tolerate a catch — but we
      // surface the failure structurally rather than swallowing it. A broken
      // audit log is a security incident, not a no-op.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[CapabilityBroker] Failed to append capability audit record at ${this.auditFilePath} (policyKey=${policyKey}): ${message}`,
      );
      throw err;
    }
  }
}

let cachedBroker: CapabilityBroker | null = null;

export function getCapabilityBroker(): CapabilityBroker {
  if (cachedBroker) return cachedBroker;
  cachedBroker = new CapabilityBroker();
  return cachedBroker;
}

/**
 * Test-only escape hatch — drops the cached singleton so the next call to
 * `getCapabilityBroker()` re-reads env. Not exported to consumers via the
 * package barrel.
 */
export function __resetCapabilityBrokerForTests(): void {
  cachedBroker = null;
}
