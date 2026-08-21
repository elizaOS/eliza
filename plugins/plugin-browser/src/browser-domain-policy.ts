/**
 * Per-domain browser command policy hooks (issue #19882).
 *
 * Host plugins register {@link BrowserDomainPolicy} implementations that gate
 * side-effecting browser commands by target domain before dispatch, and gate
 * workspace form submissions at the exact moment the resolved submit URL is
 * known. The registry lives on a `globalThis` symbol (mirroring
 * `browser-capture-hooks.ts`) so both the `BrowserService` dispatcher and the
 * module-level workspace form path consult one source of truth without an
 * import edge back into the service.
 *
 * Evaluation is fail-closed: a policy that throws counts as a block, the first
 * non-allow decision wins, and the built-in allowlist policy treats an
 * unresolvable domain as unknown (blocked unless explicitly permitted). With
 * no registered policies every command is allowed, preserving the dispatcher's
 * existing behavior — the generic eval/upload hard block in `BrowserService`
 * remains in force regardless of policy registration.
 */

import { browserBridgeDomainFromUrl } from "./bridge-policy.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceSubaction,
} from "./workspace/browser-workspace-types.js";

/** Broad side-effect class of a browser subaction, used for policy matching. */
export type BrowserCommandEffect =
  | "read"
  | "interact"
  | "navigate"
  | "submit"
  | "upload"
  | "eval";

const READ_SUBACTIONS: ReadonlySet<string> = new Set([
  "list",
  "state",
  "get",
  "snapshot",
  "screenshot",
  "inspect",
  "console",
  "errors",
  "network",
  "diff",
  "find",
  "highlight",
  "pdf",
  "profiler",
  "trace",
  "wait",
  "cursor-move",
  "cursor-hide",
]);

const NAVIGATE_SUBACTIONS: ReadonlySet<string> = new Set([
  "open",
  "navigate",
  "reload",
  "back",
  "forward",
]);

const UPLOAD_SUBACTIONS: ReadonlySet<string> = new Set([
  "upload",
  "realistic-upload",
]);

/**
 * Maps a subaction to its side-effect class. Unknown subactions classify as
 * `interact` so a new mutating subaction is never silently treated as a read.
 * Form submission is not a distinct subaction — it happens inside click/press
 * handling — so `submit` is only produced by the workspace submit interception
 * point, never by this classifier.
 */
export function classifyBrowserCommandEffect(
  subaction: BrowserWorkspaceSubaction | string,
): BrowserCommandEffect {
  const normalized = String(subaction).trim().toLowerCase();
  if (normalized === "eval") return "eval";
  if (UPLOAD_SUBACTIONS.has(normalized)) return "upload";
  if (NAVIGATE_SUBACTIONS.has(normalized)) return "navigate";
  if (READ_SUBACTIONS.has(normalized)) return "read";
  return "interact";
}

/** Where in the command lifecycle a policy request originates. */
export type BrowserDomainPolicyPhase = "dispatch" | "submit";

export interface BrowserDomainPolicyRequest {
  /** The command subaction under evaluation (batch steps evaluate individually). */
  readonly subaction: string;
  /** Side-effect class; `submit` only at the workspace submit interception point. */
  readonly effect: BrowserCommandEffect;
  /**
   * Lowercased http(s) hostname the command addresses, or `null` when the
   * command carries no URL (e.g. a click whose page is only known to the
   * target). Policies decide how to treat unknown domains; the built-in
   * allowlist policy fails closed for side-effecting commands.
   */
  readonly domain: string | null;
  /** The raw URL the domain was derived from, when the command carried one. */
  readonly url: string | null;
  /** Pinned target id, when the caller pinned one. */
  readonly targetId: string | null;
  readonly phase: BrowserDomainPolicyPhase;
}

export type BrowserDomainPolicyVerdict =
  | "allow"
  | "block"
  | "require_confirmation";

export interface BrowserDomainPolicyDecision {
  readonly verdict: BrowserDomainPolicyVerdict;
  /** Human-readable justification surfaced in the typed dispatch failure. */
  readonly reason: string;
  /** Id of the policy that produced this decision. */
  readonly policyId: string;
}

export interface BrowserDomainPolicy {
  /** Stable identifier used in decisions and diagnostics. */
  readonly id: string;
  /**
   * Pure decision for one request. Must not perform I/O. Throwing counts as a
   * block for the request (fail-closed), never as an allow.
   */
  evaluate(request: BrowserDomainPolicyRequest): BrowserDomainPolicyDecision;
}

const BROWSER_DOMAIN_POLICIES = Symbol.for("elizaos.browser-domain.policies");

type BrowserDomainPolicyGlobal = typeof globalThis & {
  [BROWSER_DOMAIN_POLICIES]?: Map<string, BrowserDomainPolicy>;
};

function policyRegistry(): Map<string, BrowserDomainPolicy> {
  const holder = globalThis as BrowserDomainPolicyGlobal;
  let registry = holder[BROWSER_DOMAIN_POLICIES];
  if (!registry) {
    registry = new Map();
    holder[BROWSER_DOMAIN_POLICIES] = registry;
  }
  return registry;
}

/** Registers (or replaces, by id) a domain policy. */
export function registerBrowserDomainPolicy(policy: BrowserDomainPolicy): void {
  if (typeof policy.id !== "string" || policy.id.trim().length === 0) {
    throw new Error(
      "BrowserDomainPolicy registration requires a non-empty id.",
    );
  }
  policyRegistry().set(policy.id, policy);
}

export function unregisterBrowserDomainPolicy(id: string): boolean {
  return policyRegistry().delete(id);
}

export function listBrowserDomainPolicies(): BrowserDomainPolicy[] {
  return [...policyRegistry().values()];
}

/**
 * Evaluates every registered policy in registration order. The first non-allow
 * decision wins; a throwing policy blocks the request. Returns an allow
 * decision when no policy objects (including when none are registered).
 */
export function evaluateBrowserDomainPolicies(
  request: BrowserDomainPolicyRequest,
): BrowserDomainPolicyDecision {
  const frozen = Object.freeze({ ...request });
  for (const policy of policyRegistry().values()) {
    let decision: unknown;
    try {
      decision = policy.evaluate(frozen);
    } catch (error) {
      // error-policy:J3 untrusted-hook sanitizing — a policy hook that throws
      // must fail closed as a block, never fall through to allow.
      const message = error instanceof Error ? error.message : String(error);
      return {
        verdict: "block",
        reason: `Domain policy "${policy.id}" failed during evaluation: ${message}`,
        policyId: policy.id,
      };
    }
    // A hook is untrusted input: a non-object return (null, undefined, a
    // string) must block rather than throw a TypeError on property access,
    // which would escape this fail-closed boundary as an opaque crash.
    if (typeof decision !== "object" || decision === null) {
      return {
        verdict: "block",
        reason: `Domain policy "${policy.id}" returned a non-decision value.`,
        policyId: policy.id,
      };
    }
    let verdict: unknown;
    let reason: unknown;
    try {
      // Accessor properties on a hook's decision object are as untrusted as
      // the hook itself: a throwing getter must block, not escape as an
      // untyped error past this fail-closed boundary.
      verdict = (decision as { verdict?: unknown }).verdict;
      reason = (decision as { reason?: unknown }).reason;
    } catch (error) {
      // error-policy:J3 untrusted-hook sanitizing — a decision property getter
      // that throws must fail closed as a block, never fall through to allow.
      const message = error instanceof Error ? error.message : String(error);
      return {
        verdict: "block",
        reason: `Domain policy "${policy.id}" returned a decision whose properties threw: ${message}`,
        policyId: policy.id,
      };
    }
    if (
      verdict !== "allow" &&
      verdict !== "block" &&
      verdict !== "require_confirmation"
    ) {
      return {
        verdict: "block",
        reason: `Domain policy "${policy.id}" returned an unrecognized verdict.`,
        policyId: policy.id,
      };
    }
    if (verdict !== "allow") {
      return {
        verdict,
        reason:
          typeof reason === "string" && reason.trim().length > 0
            ? reason
            : `Domain policy "${policy.id}" returned verdict "${verdict}".`,
        policyId: policy.id,
      };
    }
  }
  return {
    verdict: "allow",
    reason: "No registered domain policy objected.",
    policyId: "",
  };
}

/** Builds the policy request for one (possibly nested) command. */
export function browserDomainPolicyRequestForCommand(
  command: BrowserWorkspaceCommand,
  targetId: string | null,
): BrowserDomainPolicyRequest {
  const url = typeof command.url === "string" ? command.url : null;
  return {
    subaction: command.subaction,
    effect: classifyBrowserCommandEffect(command.subaction),
    domain: url ? browserBridgeDomainFromUrl(url) : null,
    url,
    targetId,
    phase: "dispatch",
  };
}

export interface BrowserDomainAllowlistPolicyOptions {
  id: string;
  /**
   * Domains permitted for the gated effects. A tab-visited domain matches
   * exactly or as a subdomain (`login.example.com` matches `example.com`).
   */
  allowedDomains: string[];
  /**
   * Side-effect classes the allowlist gates. Defaults to the dangerous set:
   * navigate, submit, upload, and eval. Reads and generic interactions pass.
   */
  gatedEffects?: BrowserCommandEffect[];
  /**
   * Verdict for a gated command whose domain cannot be resolved. Defaults to
   * "block" (fail closed): a submit or navigation to an unknown destination
   * is never silently allowed.
   */
  unknownDomainVerdict?: Exclude<BrowserDomainPolicyVerdict, "allow">;
  /** Verdict for gated commands outside the allowlist. Defaults to "block". */
  deniedVerdict?: Exclude<BrowserDomainPolicyVerdict, "allow">;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

function domainMatches(domain: string, allowed: string): boolean {
  return domain === allowed || domain.endsWith(`.${allowed}`);
}

/**
 * Concrete fail-closed allowlist policy. Gated side-effecting commands are
 * only allowed on the listed domains; unresolvable domains fail closed.
 */
export function createBrowserDomainAllowlistPolicy(
  options: BrowserDomainAllowlistPolicyOptions,
): BrowserDomainPolicy {
  const allowed = options.allowedDomains
    .map(normalizeDomain)
    .filter((domain) => domain.length > 0);
  if (allowed.length === 0) {
    throw new Error(
      "createBrowserDomainAllowlistPolicy requires at least one valid domain.",
    );
  }
  const gated: ReadonlySet<BrowserCommandEffect> = new Set(
    options.gatedEffects ?? ["navigate", "submit", "upload", "eval"],
  );
  const unknownVerdict = options.unknownDomainVerdict ?? "block";
  const deniedVerdict = options.deniedVerdict ?? "block";
  return {
    id: options.id,
    evaluate(request) {
      if (!gated.has(request.effect)) {
        return {
          verdict: "allow",
          reason: `Effect "${request.effect}" is not gated by this allowlist.`,
          policyId: options.id,
        };
      }
      if (request.domain === null) {
        return {
          verdict: unknownVerdict,
          reason: `Gated browser ${request.effect} has no resolvable http(s) domain.`,
          policyId: options.id,
        };
      }
      const domain = request.domain;
      if (allowed.some((candidate) => domainMatches(domain, candidate))) {
        return {
          verdict: "allow",
          reason: `Domain "${domain}" is allowlisted.`,
          policyId: options.id,
        };
      }
      return {
        verdict: deniedVerdict,
        reason: `Domain "${domain}" is not in the browser ${request.effect} allowlist.`,
        policyId: options.id,
      };
    },
  };
}
