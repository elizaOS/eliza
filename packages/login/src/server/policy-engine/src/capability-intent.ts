/**
 * capability-intent.ts — the `capability-intent` contributed policy rule.
 *
 * WHAT THIS GATES
 * ---------------
 * a `capability-intent` rule governs whether an agent may INVOKE a named
 * capability (e.g. `github.pr.comment`) through Steward's capability layer. it
 * is the per-call-intent policy the credential plane leans on before delegating
 * to the proxy: the invoke route (W-1c) populates `ctx.capability` with the
 * capability name/args/host/path/method, and this rule decides allow / deny /
 * require-approval, plus argument- and rate-constraints.
 *
 * WHY IT LIVES HERE (policy-engine) BUT LOOKS LIKE A PLUGIN CONTRIBUTION
 * ---------------------------------------------------------------------
 * it is authored AS a {@link PolicyRuleContribution} — the exact shape a plugin
 * registers via the provider-mode registry — so the capability plugin can register
 * it through the plugin host with ZERO rework. but the evaluator + config schema
 * + tests are a library export of `@stwd/policy-engine` (not a route, not a
 * package): W-1b ships the decision logic; the plugin package (W-1a) owns
 * registration; the invoke path (W-1c) owns wiring the context + the effective
 * default-deny (see the INVOKE-LAYER CONTRACT below).
 *
 * FAIL-CLOSED EVERYWHERE
 * ----------------------
 * this rule sits in front of live credentials (money-rail-adjacent), so every
 * ambiguity denies: a missing/mistyped config, a constrained arg that is absent,
 * an invalid regex in config, a rate cap without a count — all deny. the rule
 * NEVER throws (a throw would be caught by the registry as a deny, but we prefer
 * an explicit reason) and NEVER silently passes a governed action.
 *
 * APPLICABILITY (mirrors the typed-data pattern)
 * ----------------------------------------------
 *  - `ctx.capability` ABSENT  -> not a capability invoke -> PASS (this rule is
 *    inert on ordinary transaction signs; it cannot interfere with tx signing).
 *  - `ctx.capability` PRESENT but the capability NAME does not match this rule's
 *    `capabilities` list -> NOT APPLICABLE -> PASS. this rule only evaluates the
 *    capabilities it governs; whether an UNGOVERNED capability is allowed is the
 *    invoke layer's default-deny decision, NOT this rule's.
 *
 * INVOKE-LAYER CONTRACT (what W-1c must implement)
 * ------------------------------------------------
 * the engine composes all rules with all-must-pass semantics, and this rule
 * passes for any capability it does not name. that means "no rule allows this
 * capability" evaluates to PASS at the engine level. therefore the EFFECTIVE
 * DEFAULT-DENY must live in the INVOKE LAYER (W-1c):
 *   1. resolve the grant fail-closed; if no grant, deny before policy runs.
 *   2. after the engine's decision, REQUIRE that at least one `capability-intent`
 *      rule MATCHED the invoked capability with `effect: "allow"` (and passed).
 *      if the capability matched no allow rule, DENY — an invoke is permitted
 *      only when explicitly allowed, never by the absence of a deny.
 *   3. populate `ctx.capability` (name/args/host/path/method) AND
 *      `ctx.capabilityInvokeCount1h` (trailing-hour invoke count for this agent)
 *      so `maxCallsPerHour` can be enforced. absent count => this rule denies.
 *   4. audit every invoke + decision.
 */

import { RE2 } from "re2-wasm";
import type {
  ContributedPolicyResult,
  ContributedPolicyRule,
  PolicyRuleContribution,
} from "../../shared/src/index.ts";
import { describeThrown } from "../../shared/src/index.ts";
import type { EvaluatorContext } from "./evaluators";

/** the contributed rule-type discriminator. */
export const CAPABILITY_INTENT_RULE_TYPE = "capability-intent" as const;

/**
 * ReDoS blast-radius bounds for operator-supplied patterns (SEC-107).
 * `argMatches` / X `blockedPatterns` regexes come from tenant-admin policy
 * config and run against agent-influenced invoke args / tweet text. They are
 * evaluated with RE2's linear-time engine; length caps remain defense in depth
 * for compile/match cost and bound policy-controlled memory use.
 */
export const MAX_POLICY_PATTERN_LENGTH = 256;
export const MAX_POLICY_PATTERN_INPUT_LENGTH = 8_192;
const MAX_ARG_ARRAY_VALUES = 64;
const MAX_ARG_ARRAY_VALUE_LENGTH = 512;

// ─── Permissioned-X: per-post price table (versioned constant) ────────────────
//
// SOURCE (captured 2026-07-16, docs.x.com pay-per-use, effective Feb 6 2026):
//   - a post WITHOUT a URL costs $0.015  => 15000 micro-dollars
//   - a post WITH a URL     costs $0.20   => 200000 micro-dollars
// Denominated in micro-dollars (integer-exact; no float spend math). A price
// change is a reviewable diff to this constant, never silent drift. This is an
// ESTIMATE table for the spend-cap policy, NOT a billing oracle.
export const X_POST_PRICE_TABLE_VERSION = "x-post-price.v1" as const;
export const X_POST_PRICE_TABLE_V1 = {
  /** plain text post, no URL: $0.015 */
  plainMicros: 15_000,
  /** post containing a URL: $0.20 */
  urlMicros: 200_000,
} as const;

/** Estimated micro-dollar cost of a single tweet.create action. */
export function estimateXPostMicros(hasUrl: boolean): number {
  return hasUrl
    ? X_POST_PRICE_TABLE_V1.urlMicros
    : X_POST_PRICE_TABLE_V1.plainMicros;
}

/** The effect a matching `capability-intent` rule applies. */
export type CapabilityIntentEffect = "allow" | "deny" | "require-approval";

// ─── Cumulative spend caps (#206, Privy aggregate-limit parity) ───────────────
//
// A `cumulativeSpend` constraint bounds the TOTAL money an agent may move through
// a capability over a trailing time window - the canonical agentic-wallet
// guardrail a call-count cap cannot express (10 calls moving $1M each pass
// `maxCallsPerHour: 20`). It mirrors the permissioned-X spend cap already in this
// file (accumulated window spend + this action's cost, integer micros, deny on
// breach) but generalizes it to:
//   - a CONFIGURABLE trailing window (ISO-8601 duration, not a hardcoded hour),
//   - a declared CURRENCY (no FX - a currency mismatch denies),
//   - a selectable AGGREGATION SCOPE (operation / agent / grant),
//   - a per-operation spend value derived ONLY from validated `policyArgs` via a
//     declared, typed field (never raw JSON; an operation without the declared
//     field cannot pass a cumulativeSpend-constrained rule → deny, not skip).
//
// The trailing-window sum + the atomic reservation that makes concurrent invokes
// single-winner live in the invoke layer (packages/redis + provider-action
// service); this module is the fail-closed decision logic + config schema. Absent
// aggregate context ⇒ DENY (same missing-signal discipline as maxCallsPerHour and
// the permissioned-X inputs).

/** The aggregation scope a cumulativeSpend cap sums over. */
export type CumulativeSpendScope = "operation" | "agent" | "grant";

/**
 * A cumulative (aggregate) spend cap over a trailing window.
 *   - `window`: ISO-8601 duration (e.g. `PT1H`, `PT24H`, `P1D`, `P7D`). Parsed
 *     fail-closed to a positive integer number of seconds; a malformed or
 *     zero/negative duration is a config error (deny at store AND at runtime).
 *   - `currency`: opaque currency/asset tag (e.g. `USD`, `USDC`). Compared
 *     verbatim against the operation's spend currency - NO FX conversion. A
 *     mismatch denies with a stable code.
 *   - `max`: the cap, an INTEGER in the currency's minor unit (micros/cents -
 *     the caller's convention). No floats. Non-negative.
 *   - `aggregateOver`: which trailing-window sum to compare against - the
 *     per-operation sum, the whole-agent sum, or the per-grant sum.
 */
export interface CumulativeSpendConstraint {
  readonly window: string;
  readonly currency: string;
  readonly max: number;
  readonly aggregateOver: CumulativeSpendScope;
}

// ─── Permissioned-X constraint sub-block (X-only) ──────────────────────────
//
// This is the instance-level X policy vocabulary X's native OAuth2 scopes cannot
// express (see docs/security/permissioned-x.mdx). It lives INSIDE
// capability-intent constraints so X flows through the SAME composer + precedence
// + persisted decision doc as github — no new rule type, no invented registry.
// The `x` block is ONLY valid on an `x.*` operation; on a non-X operation it is a
// config error (fail closed). All sub-fields fail closed.

/** replyPolicy.mode: gate replies independently of original posts. */
export type XReplyMode = "any" | "summoned-only" | "none";

/** Content conditions on a tweet's text (adapter-derived signals). */
export interface XContentPolicy {
  /** false => any post whose text contains a URL is denied (also a spend lever:
   *  a URL post costs $0.20 vs $0.015). */
  readonly allowUrls?: boolean;
  /** deny a post whose adapter-counted code-point length exceeds this. */
  readonly maxLength?: number;
  /** anchored regexes; a match on the (in-memory) tweet text denies. An invalid
   *  regex denies (fail closed). */
  readonly blockedPatterns?: string[];
}

/** replyPolicy: gate replies vs originals + the summoned-only precondition. */
export interface XReplyPolicy {
  readonly mode: XReplyMode;
}

/** maxPostsPerWindow: operator-authored count cap over a trailing window. */
export interface XPostsWindowCap {
  readonly max: number;
  readonly windowSeconds: number;
}

/** spendPolicy: estimated micro-dollar spend ceiling over the price table. */
export interface XSpendPolicy {
  readonly maxSpendMicros: number;
}

/** escalation: conditions that downgrade an allow to approval_required. */
export interface XEscalationPolicy {
  /** any URL post routes to human approval even if allowUrls is true. */
  readonly urlPostRequiresApproval?: boolean;
  /** estimated spend over this (but under the hard cap) routes to approval. */
  readonly spendOverMicrosRequiresApproval?: number;
}

/** quietHours: UTC minute-of-day window in which writes are denied. */
export interface XQuietHours {
  /** inclusive start minute-of-day UTC, 0..1439. */
  readonly startMinuteUtc: number;
  /** exclusive end minute-of-day UTC, 0..1439. Wrap (start>end) spans midnight. */
  readonly endMinuteUtc: number;
}

/** The X-only constraint sub-block. */
export interface XConstraints {
  readonly replyPolicy?: XReplyPolicy;
  readonly contentPolicy?: XContentPolicy;
  readonly maxPostsPerWindow?: XPostsWindowCap;
  readonly spendPolicy?: XSpendPolicy;
  readonly escalation?: XEscalationPolicy;
  readonly quietHours?: XQuietHours;
}

/** Constraints evaluated ONLY on an `effect: "allow"` match. */
export interface CapabilityIntentConstraints {
  /** Local business-hours allow windows evaluated from a server-supplied instant. */
  readonly timeWindow?: CapabilityTimeWindow;
  /**
   * Max capability INVOKES per trailing hour. Evaluated against
   * `ctx.capabilityInvokeCount1h` (NOT the tx counter). If this is set but the
   * count is absent, the rule DENIES (fail closed) — the invoke layer (W-1c)
   * must wire the count.
   *
   * BACKWARD COMPAT (#206): this remains the hardcoded-1h count cap and keeps
   * working unchanged. For a configurable window use {@link maxCalls} +
   * {@link callWindow}. `maxCallsPerHour` and `maxCalls` are mutually exclusive
   * (both set => config error) so there is exactly one count cap per rule.
   */
  readonly maxCallsPerHour?: number;
  /**
   * Configurable count cap (#206): max capability invokes over the trailing
   * window {@link callWindow}. Evaluated against the invoke-count the invoke
   * layer supplies for THAT window; absent count => DENY (fail closed, same as
   * `maxCallsPerHour`). Requires {@link callWindow}. Mutually exclusive with
   * `maxCallsPerHour`.
   */
  readonly maxCalls?: number;
  /**
   * ISO-8601 duration for {@link maxCalls} (e.g. `PT1H`, `PT30M`, `P1D`). Parsed
   * fail-closed to a positive integer number of seconds. Required when `maxCalls`
   * is set; invalid without `maxCalls`.
   */
  readonly callWindow?: string;
  /**
   * Cumulative (aggregate) spend cap over a trailing window (#206). Evaluated
   * against the trailing-window spend sum the invoke layer supplies for the
   * configured {@link CumulativeSpendConstraint.aggregateOver} scope; absent
   * aggregate => DENY (fail closed). See {@link CumulativeSpendConstraint}.
   */
  readonly cumulativeSpend?: CumulativeSpendConstraint;
  /**
   * Every key must exist in `ctx.capability.args` and STRICTLY (===) equal the
   * configured string. A missing arg or a mismatch denies.
   */
  readonly argEquals?: Record<string, string>;
  /**
   * Every key must exist in `ctx.capability.args` and match the configured
   * regex (full-string, anchored). A missing arg, a non-string arg, or a
   * no-match denies. An INVALID regex in config denies (compiled defensively;
   * never throws).
   */
  readonly argMatches?: Record<string, string>;
  /**
   * Every named arg must be a non-empty string array, and every element must
   * belong to the configured allowlist. This is an array-subset check, not a
   * string coercion; malformed, mixed-type, empty, or over-bounded arrays deny.
   */
  readonly argArraySubset?: Record<string, string[]>;
  /**
   * X-only instance-level policy sub-block (permissioned X). ONLY valid on an
   * `x.*` operation — present on a non-X operation => config error (fail closed).
   * See {@link XConstraints} + docs/security/permissioned-x.mdx.
   */
  readonly x?: XConstraints;
}

export type CapabilityWeekday =
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat"
  | "sun";

export interface CapabilityTimeWindowEntry {
  readonly days: CapabilityWeekday[];
  /** Inclusive local wall-clock start, HH:MM. */
  readonly from: string;
  /** Exclusive local wall-clock end, HH:MM. Overnight windows are supported. */
  readonly to: string;
}

export interface CapabilityTimeWindow {
  readonly timezone: string;
  readonly allow: CapabilityTimeWindowEntry[];
}

/** The jsonb config of a `capability-intent` rule. */
export interface CapabilityIntentConfig {
  /**
   * Capability names this rule governs. Exact names (`github.pr.comment`) or a
   * SINGLE trailing-`.*` prefix glob (`github.*` matches `github.pr.comment`).
   * No general globbing. Case-sensitive.
   */
  readonly capabilities: string[];
  readonly effect: CapabilityIntentEffect;
  readonly constraints?: CapabilityIntentConstraints;
}

/**
 * Match a capability name against a single pattern.
 *   - trailing `.*` => prefix match on everything before the `.` (so `github.*`
 *     matches `github.pr.comment` and `github.x`, but NOT `github` itself and
 *     NOT `githubx.y`).
 *   - otherwise exact, case-sensitive.
 */
function patternMatches(pattern: string, name: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep the trailing "." e.g. "github."
    return name.startsWith(prefix);
  }
  return pattern === name;
}

/** True when any configured pattern matches the invoked capability name. */
function capabilityMatches(
  config: CapabilityIntentConfig,
  name: string,
): boolean {
  return config.capabilities.some((pattern) => patternMatches(pattern, name));
}

/**
 * Recover ONLY the capability SELECTOR (the `capabilities` patterns) from an
 * otherwise-malformed rule config, WITHOUT validating the rest of the config.
 *
 * WHY THIS EXISTS (scope isolation, master-plan §5.3 / §"malformed-input
 * precedence applies to GOVERNING rules"):
 *   malformed-input precedence must apply to the rules that GOVERN the requested
 *   capability. A rule whose selector is well-formed and demonstrably scoped to a
 *   DIFFERENT capability must not brick an unrelated invoke just because some
 *   OTHER part of its config (effect, constraints) is malformed — it is not a
 *   governing rule for this request, so it is inert.
 *
 * RECOVERABILITY CONTRACT (fail closed on ambiguous scope):
 *   - `{ recoverable: true, matches }` when the `capabilities` selector is
 *     unambiguously well-formed: a non-empty array of non-empty strings whose
 *     glob usage is legal (same rule as `parseConfig`'s `badPattern` check). We
 *     can then say for certain whether it governs THIS capability (`matches`).
 *   - `{ recoverable: false }` when the selector itself cannot be trusted to
 *     determine scope (missing / not an array / empty / a non-string or empty
 *     entry / an illegal glob). We CANNOT rule out that this rule was meant to
 *     govern the requested capability, so the caller must treat it as
 *     potentially governing and hard-deny (never assume it is inert).
 *
 * This deliberately mirrors the selector-shaped checks in `parseConfig` so a
 * selector that would be REJECTED there is also "unrecoverable" here.
 */
function recoverSelectorMatch(
  rawInput: unknown,
  name: string,
): { recoverable: true; matches: boolean } | { recoverable: false } {
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    return { recoverable: false };
  }
  const capabilities = (rawInput as Record<string, unknown>).capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    !capabilities.every((c) => typeof c === "string" && c.length > 0)
  ) {
    return { recoverable: false };
  }
  // An illegal glob makes the selector's intended scope ambiguous (a bad pattern
  // can never match, so treating it as "non-governing" would be exactly the
  // silent-drop failure `parseConfig`'s badPattern check guards against). Fail
  // closed: unrecoverable.
  const badPattern = (capabilities as string[]).find(
    (p) =>
      p.includes("*") && !(p.endsWith(".*") && !p.slice(0, -2).includes("*")),
  );
  if (badPattern !== undefined) {
    return { recoverable: false };
  }
  const matches = (capabilities as string[]).some((pattern) =>
    patternMatches(pattern, name),
  );
  return { recoverable: true, matches };
}

/**
 * Validate the (opaque) rule config into a typed shape, or return an error
 * reason. FAIL CLOSED: anything malformed is rejected (the caller denies).
 */
const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "capabilities",
  "effect",
  "constraints",
]);
const ALLOWED_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
  "maxCallsPerHour",
  "maxCalls",
  "callWindow",
  "cumulativeSpend",
  "argEquals",
  "argMatches",
  "argArraySubset",
  "timeWindow",
  "x",
]);
const ALLOWED_CUMULATIVE_SPEND_KEYS: ReadonlySet<string> = new Set([
  "window",
  "currency",
  "max",
  "aggregateOver",
]);
const CUMULATIVE_SPEND_SCOPES: ReadonlySet<string> = new Set([
  "operation",
  "agent",
  "grant",
]);
const WEEKDAYS: readonly CapabilityWeekday[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];
const WEEKDAY_SET: ReadonlySet<string> = new Set(WEEKDAYS);
const HH_MM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const ISO_FIXED_OFFSET_TIMEZONE = /^[+-]/;

function minuteOfDay(value: string): number | null {
  const match = HH_MM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function parseTimeWindow(
  raw: unknown,
): CapabilityTimeWindow | { error: string } {
  if (!isPlainObject(raw))
    return {
      error: "capability-intent: `constraints.timeWindow` must be an object",
    };
  const unknown = Object.keys(raw).filter(
    (key) => key !== "timezone" && key !== "allow",
  );
  if (unknown.length)
    return {
      error: `capability-intent: unknown constraints.timeWindow key(s): ${unknown.join(", ")}`,
    };
  if (
    typeof raw.timezone !== "string" ||
    !raw.timezone ||
    raw.timezone.length > 128 ||
    ISO_FIXED_OFFSET_TIMEZONE.test(raw.timezone)
  ) {
    return {
      error:
        "capability-intent: `timeWindow.timezone` must be an IANA timezone",
    };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw.timezone }).format(
      new Date(0),
    );
  } catch {
    return {
      error:
        "capability-intent: `timeWindow.timezone` must be an IANA timezone",
    };
  }
  if (
    !Array.isArray(raw.allow) ||
    raw.allow.length === 0 ||
    raw.allow.length > 64
  ) {
    return {
      error: "capability-intent: `timeWindow.allow` must contain 1..64 windows",
    };
  }
  const allow: CapabilityTimeWindowEntry[] = [];
  for (const candidate of raw.allow) {
    if (!isPlainObject(candidate))
      return { error: "capability-intent: each time window must be an object" };
    const extra = Object.keys(candidate).filter(
      (key) => key !== "days" && key !== "from" && key !== "to",
    );
    if (extra.length)
      return {
        error: `capability-intent: unknown time window key(s): ${extra.join(", ")}`,
      };
    if (
      !Array.isArray(candidate.days) ||
      candidate.days.length === 0 ||
      candidate.days.some(
        (day) => typeof day !== "string" || !WEEKDAY_SET.has(day),
      )
    ) {
      return {
        error:
          "capability-intent: time window days must be non-empty lowercase weekdays",
      };
    }
    if (new Set(candidate.days).size !== candidate.days.length) {
      return {
        error:
          "capability-intent: time window days must not contain duplicates",
      };
    }
    if (
      typeof candidate.from !== "string" ||
      typeof candidate.to !== "string" ||
      minuteOfDay(candidate.from) === null ||
      minuteOfDay(candidate.to) === null ||
      candidate.from === candidate.to
    ) {
      return {
        error:
          "capability-intent: time window from/to must be distinct HH:MM values",
      };
    }
    allow.push({
      days: candidate.days as CapabilityWeekday[],
      from: candidate.from,
      to: candidate.to,
    });
  }
  return { timezone: raw.timezone, allow };
}

function timeWindowAllows(
  window: CapabilityTimeWindow,
  evaluatedAt: string | undefined,
): "allow" | "deny" | "unavailable" {
  if (typeof evaluatedAt !== "string") return "unavailable";
  const instant = new Date(evaluatedAt);
  if (!Number.isFinite(instant.getTime())) return "unavailable";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: window.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    return "unavailable";
  }
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const day = byType.weekday?.slice(0, 3).toLowerCase() as
    | CapabilityWeekday
    | undefined;
  const minute = Number(byType.hour) * 60 + Number(byType.minute);
  if (!day || !WEEKDAY_SET.has(day) || !Number.isInteger(minute))
    return "unavailable";
  const dayIndex = WEEKDAYS.indexOf(day);
  const previousDay = WEEKDAYS[(dayIndex + 6) % 7];
  for (const entry of window.allow) {
    const from = minuteOfDay(entry.from) as number;
    const to = minuteOfDay(entry.to) as number;
    if (from < to && entry.days.includes(day) && minute >= from && minute < to)
      return "allow";
    if (
      from > to &&
      ((entry.days.includes(day) && minute >= from) ||
        (entry.days.includes(previousDay) && minute < to))
    )
      return "allow";
  }
  return "deny";
}

/**
 * Parse a restricted ISO-8601 duration into a positive integer number of
 * seconds, or `null` on ANY malformed / zero / negative / non-integer / OVER-
 * RETENTION input (fail closed).
 *
 * SUPPORTED SUBSET (deliberately restricted so the parse is total + auditable):
 *   `P[nD]T[nH][nM][nS]` and the time-only `PT[nH][nM][nS]` - integer,
 *   non-negative components; at least one component must be present and the
 *   total must be > 0. Weeks (`PnW`) are also accepted as a standalone form.
 *   Years/months (`PnY`, `PnM` in the DATE position) are REJECTED: their second
 *   count is not fixed, so a spend WINDOW over them would be ambiguous (a money
 *   gate must never rest on an ambiguous window length).
 *
 * OVER-RETENTION REJECTED (codex P1): a window longer than the aggregate store's
 * retention ({@link MAX_AGGREGATE_WINDOW_SECONDS}, 30d) would SILENTLY under-
 * enforce - entries older than retention are pruned, so a `P90D` cap would
 * behave like a 30d cap and let spend from days 31-90 slip. We reject such a
 * window at parse time (store AND runtime) rather than clamp: a money cap must
 * never be quietly weakened to a shorter effective window.
 *
 * Examples: `PT1H`->3600, `PT24H`->86400, `P1D`->86400, `P7D`->604800,
 *           `PT30M`->1800, `P1W`->604800, `P30D`->2592000. `P0D`/`PT0S`/`P`/`PT`/
 *           `P1M` (month)/`P90D` (over retention) -> null.
 */
/** Aggregate-store retention: the longest trailing window a cumulativeSpend /
 *  configurable count cap may declare. MUST match the redis tracker's
 *  MAX_WINDOW_SECONDS (30d); a window beyond it cannot be enforced. */
export const MAX_AGGREGATE_WINDOW_SECONDS = 2592000;
function parseIso8601DurationSeconds(input: unknown): number | null {
  if (typeof input !== "string" || input.length === 0) return null;
  // Weeks form: PnW (standalone, no other components).
  const weeks = /^P(\d+)W$/.exec(input);
  if (weeks) {
    const n = Number(weeks[1]);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const secs = n * 604800;
    if (secs > MAX_AGGREGATE_WINDOW_SECONDS) return null;
    return secs;
  }
  // Date(days-only) + time form. Reject Y/M (ambiguous length) by not matching
  // them at all. Require the T section to be absent OR non-empty.
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(input);
  if (!m) return null;
  const [, dStr, hStr, mStr, sStr] = m;
  // Must carry at least one component; a bare "P" or "PT" is meaningless.
  if (
    dStr === undefined &&
    hStr === undefined &&
    mStr === undefined &&
    sStr === undefined
  ) {
    return null;
  }
  // If a `T` was written it must be followed by at least one time component: the
  // regex allows "PT" (all time groups undefined) with a days component, but a
  // bare "PT" (no days, no time) is caught by the all-undefined guard above.
  const days = dStr === undefined ? 0 : Number(dStr);
  const hours = hStr === undefined ? 0 : Number(hStr);
  const mins = mStr === undefined ? 0 : Number(mStr);
  const secs = sStr === undefined ? 0 : Number(sStr);
  for (const n of [days, hours, mins, secs]) {
    if (!Number.isSafeInteger(n) || n < 0) return null;
  }
  const total = days * 86400 + hours * 3600 + mins * 60 + secs;
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  // Over-retention windows cannot be enforced (they would silently clamp) - reject.
  if (total > MAX_AGGREGATE_WINDOW_SECONDS) return null;
  return total;
}

// Permissioned-X allowed keys (fail closed on any typo).
const ALLOWED_X_KEYS: ReadonlySet<string> = new Set([
  "replyPolicy",
  "contentPolicy",
  "maxPostsPerWindow",
  "spendPolicy",
  "escalation",
  "quietHours",
]);
const ALLOWED_REPLY_KEYS: ReadonlySet<string> = new Set(["mode"]);
const ALLOWED_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "allowUrls",
  "maxLength",
  "blockedPatterns",
]);
const ALLOWED_WINDOW_KEYS: ReadonlySet<string> = new Set([
  "max",
  "windowSeconds",
]);
const ALLOWED_SPEND_KEYS: ReadonlySet<string> = new Set(["maxSpendMicros"]);
const ALLOWED_ESCALATION_KEYS: ReadonlySet<string> = new Set([
  "urlPostRequiresApproval",
  "spendOverMicrosRequiresApproval",
]);
const ALLOWED_QUIET_KEYS: ReadonlySet<string> = new Set([
  "startMinuteUtc",
  "endMinuteUtc",
]);
const X_REPLY_MODES: ReadonlySet<string> = new Set([
  "any",
  "summoned-only",
  "none",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0
  );
}

function isPosInt(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0
  );
}

function isMinuteOfDay(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1439;
}

/**
 * Validate the X constraint sub-block. FAIL CLOSED: any unknown key, wrong type,
 * or out-of-range value returns an error string (the caller hard-denies). Returns
 * a typed {@link XConstraints} on success.
 */
function parseXConstraints(
  rawInput: unknown,
): XConstraints | { error: string } {
  if (!isPlainObject(rawInput)) {
    return { error: "capability-intent: `constraints.x` must be an object" };
  }
  const unknown = Object.keys(rawInput).filter((k) => !ALLOWED_X_KEYS.has(k));
  if (unknown.length > 0) {
    return {
      error: `capability-intent: unknown constraints.x key(s): ${unknown.join(", ")}`,
    };
  }

  const out: {
    replyPolicy?: XReplyPolicy;
    contentPolicy?: XContentPolicy;
    maxPostsPerWindow?: XPostsWindowCap;
    spendPolicy?: XSpendPolicy;
    escalation?: XEscalationPolicy;
    quietHours?: XQuietHours;
  } = {};

  // replyPolicy
  if (rawInput.replyPolicy !== undefined) {
    const rp = rawInput.replyPolicy;
    if (!isPlainObject(rp))
      return { error: "capability-intent: `x.replyPolicy` must be an object" };
    const u = Object.keys(rp).filter((k) => !ALLOWED_REPLY_KEYS.has(k));
    if (u.length > 0)
      return {
        error: `capability-intent: unknown x.replyPolicy key(s): ${u.join(", ")}`,
      };
    if (typeof rp.mode !== "string" || !X_REPLY_MODES.has(rp.mode))
      return {
        error:
          'capability-intent: `x.replyPolicy.mode` must be "any"|"summoned-only"|"none"',
      };
    out.replyPolicy = { mode: rp.mode as XReplyMode };
  }

  // contentPolicy
  if (rawInput.contentPolicy !== undefined) {
    const cp = rawInput.contentPolicy;
    if (!isPlainObject(cp))
      return {
        error: "capability-intent: `x.contentPolicy` must be an object",
      };
    const u = Object.keys(cp).filter((k) => !ALLOWED_CONTENT_KEYS.has(k));
    if (u.length > 0)
      return {
        error: `capability-intent: unknown x.contentPolicy key(s): ${u.join(", ")}`,
      };
    const content: {
      allowUrls?: boolean;
      maxLength?: number;
      blockedPatterns?: string[];
    } = {};
    if (cp.allowUrls !== undefined) {
      if (typeof cp.allowUrls !== "boolean")
        return {
          error:
            "capability-intent: `x.contentPolicy.allowUrls` must be a boolean",
        };
      content.allowUrls = cp.allowUrls;
    }
    if (cp.maxLength !== undefined) {
      if (!isPosInt(cp.maxLength))
        return {
          error:
            "capability-intent: `x.contentPolicy.maxLength` must be a positive integer",
        };
      content.maxLength = cp.maxLength;
    }
    if (cp.blockedPatterns !== undefined) {
      if (
        !Array.isArray(cp.blockedPatterns) ||
        !cp.blockedPatterns.every((p) => typeof p === "string" && p.length > 0)
      )
        return {
          error:
            "capability-intent: `x.contentPolicy.blockedPatterns` must be a non-empty string[] of non-empty strings",
        };
      // SEC-107: bound operator-supplied regexes at parse time (same cap as
      // argMatches) so a pathological pattern fails closed as a config error.
      if (
        cp.blockedPatterns.some(
          (p) => (p as string).length > MAX_POLICY_PATTERN_LENGTH,
        )
      )
        return {
          error: `capability-intent: \`x.contentPolicy.blockedPatterns\` patterns must not exceed ${MAX_POLICY_PATTERN_LENGTH} chars`,
        };
      content.blockedPatterns = cp.blockedPatterns as string[];
    }
    out.contentPolicy = content;
  }

  // maxPostsPerWindow
  if (rawInput.maxPostsPerWindow !== undefined) {
    const w = rawInput.maxPostsPerWindow;
    if (!isPlainObject(w))
      return {
        error: "capability-intent: `x.maxPostsPerWindow` must be an object",
      };
    const u = Object.keys(w).filter((k) => !ALLOWED_WINDOW_KEYS.has(k));
    if (u.length > 0)
      return {
        error: `capability-intent: unknown x.maxPostsPerWindow key(s): ${u.join(", ")}`,
      };
    if (!isNonNegInt(w.max))
      return {
        error:
          "capability-intent: `x.maxPostsPerWindow.max` must be a non-negative integer",
      };
    if (!isPosInt(w.windowSeconds))
      return {
        error:
          "capability-intent: `x.maxPostsPerWindow.windowSeconds` must be a positive integer",
      };
    out.maxPostsPerWindow = { max: w.max, windowSeconds: w.windowSeconds };
  }

  // spendPolicy
  if (rawInput.spendPolicy !== undefined) {
    const s = rawInput.spendPolicy;
    if (!isPlainObject(s))
      return { error: "capability-intent: `x.spendPolicy` must be an object" };
    const u = Object.keys(s).filter((k) => !ALLOWED_SPEND_KEYS.has(k));
    if (u.length > 0)
      return {
        error: `capability-intent: unknown x.spendPolicy key(s): ${u.join(", ")}`,
      };
    if (!isNonNegInt(s.maxSpendMicros))
      return {
        error:
          "capability-intent: `x.spendPolicy.maxSpendMicros` must be a non-negative integer",
      };
    out.spendPolicy = { maxSpendMicros: s.maxSpendMicros };
  }

  // escalation
  if (rawInput.escalation !== undefined) {
    const e = rawInput.escalation;
    if (!isPlainObject(e))
      return { error: "capability-intent: `x.escalation` must be an object" };
    const u = Object.keys(e).filter((k) => !ALLOWED_ESCALATION_KEYS.has(k));
    if (u.length > 0)
      return {
        error: `capability-intent: unknown x.escalation key(s): ${u.join(", ")}`,
      };
    const esc: {
      urlPostRequiresApproval?: boolean;
      spendOverMicrosRequiresApproval?: number;
    } = {};
    if (e.urlPostRequiresApproval !== undefined) {
      if (typeof e.urlPostRequiresApproval !== "boolean")
        return {
          error:
            "capability-intent: `x.escalation.urlPostRequiresApproval` must be a boolean",
        };
      esc.urlPostRequiresApproval = e.urlPostRequiresApproval;
    }
    if (e.spendOverMicrosRequiresApproval !== undefined) {
      if (!isNonNegInt(e.spendOverMicrosRequiresApproval))
        return {
          error:
            "capability-intent: `x.escalation.spendOverMicrosRequiresApproval` must be a non-negative integer",
        };
      esc.spendOverMicrosRequiresApproval = e.spendOverMicrosRequiresApproval;
    }
    out.escalation = esc;
  }

  // quietHours
  if (rawInput.quietHours !== undefined) {
    const q = rawInput.quietHours;
    if (!isPlainObject(q))
      return { error: "capability-intent: `x.quietHours` must be an object" };
    const u = Object.keys(q).filter((k) => !ALLOWED_QUIET_KEYS.has(k));
    if (u.length > 0)
      return {
        error: `capability-intent: unknown x.quietHours key(s): ${u.join(", ")}`,
      };
    if (!isMinuteOfDay(q.startMinuteUtc) || !isMinuteOfDay(q.endMinuteUtc))
      return {
        error:
          "capability-intent: `x.quietHours.startMinuteUtc`/`endMinuteUtc` must be integers 0..1439",
      };
    if (q.startMinuteUtc === q.endMinuteUtc)
      return {
        error:
          "capability-intent: `x.quietHours` start and end must differ (empty/full window is ambiguous)",
      };
    out.quietHours = {
      startMinuteUtc: q.startMinuteUtc,
      endMinuteUtc: q.endMinuteUtc,
    };
  }

  return out;
}

function parseConfig(
  rawInput: unknown,
): CapabilityIntentConfig | { error: string } {
  // FAIL CLOSED on a non-object config. `rule.config` is opaque jsonb and can be
  // null / a string / a number / an array at runtime (untyped storage, bad
  // migration, hand-edited row). `Object.keys(null)` (and friends) THROW, which
  // — before this guard — surfaced as an unhandled TypeError => HTTP 500 instead
  // of a decision. A 500 is worse than a deny for a money-rail gate: it is
  // ambiguous and can be retried into a race. Treat any non-plain-object config
  // as malformed => the caller hard-denies (never throws). Arrays are rejected
  // too: a JSON array is not a valid rule config shape.
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    return {
      error: `capability-intent: config must be a non-null object (got ${
        rawInput === null
          ? "null"
          : Array.isArray(rawInput)
            ? "array"
            : typeof rawInput
      })`,
    };
  }
  const raw = rawInput as Record<string, unknown>;

  // FAIL CLOSED on unknown top-level keys: a misspelled key (e.g. `capabilties`
  // or `effects`) must never be silently ignored, since that could drop the
  // intended gate and let an action through unconstrained.
  const unknownTop = Object.keys(raw).filter(
    (k) => !ALLOWED_CONFIG_KEYS.has(k),
  );
  if (unknownTop.length > 0) {
    return {
      error: `capability-intent: unknown config key(s): ${unknownTop.join(", ")}`,
    };
  }

  const capabilities = raw.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    !capabilities.every((c) => typeof c === "string" && c.length > 0)
  ) {
    return {
      error: "capability-intent: `capabilities` must be a non-empty string[]",
    };
  }

  // FAIL CLOSED on malformed patterns: `*` is supported ONLY as a single
  // trailing `.*` prefix glob (e.g. `github.*`). Any other `*` usage (e.g.
  // `github.*.delete`, `*.delete`, `git*hub`) would be treated by
  // `patternMatches` as an exact literal that can never match, silently making
  // a deny/require-approval rule inert. Reject it at parse so the misconfig
  // denies instead of passing (codex P2).
  const badPattern = (capabilities as string[]).find(
    (p) =>
      p.includes("*") && !(p.endsWith(".*") && !p.slice(0, -2).includes("*")),
  );
  if (badPattern !== undefined) {
    return {
      error: `capability-intent: unsupported glob "${badPattern}" (\`*\` allowed only as a single trailing ".*")`,
    };
  }

  const effect = raw.effect;
  if (
    effect !== "allow" &&
    effect !== "deny" &&
    effect !== "require-approval"
  ) {
    return {
      error: `capability-intent: \`effect\` must be "allow" | "deny" | "require-approval" (got ${String(
        effect,
      )})`,
    };
  }

  let constraints: CapabilityIntentConstraints | undefined;
  if (raw.constraints !== undefined) {
    if (typeof raw.constraints !== "object" || raw.constraints === null) {
      return {
        error:
          "capability-intent: `constraints` must be an object when present",
      };
    }
    const c = raw.constraints as Record<string, unknown>;

    // FAIL CLOSED on unknown constraint keys: a typo like `maxCallPerHour` must
    // deny, not silently drop the rate cap on an `allow` rule (codex P2).
    const unknownConstraint = Object.keys(c).filter(
      (k) => !ALLOWED_CONSTRAINT_KEYS.has(k),
    );
    if (unknownConstraint.length > 0) {
      return {
        error: `capability-intent: unknown constraint key(s): ${unknownConstraint.join(", ")}`,
      };
    }

    if (c.maxCallsPerHour !== undefined) {
      if (
        typeof c.maxCallsPerHour !== "number" ||
        !Number.isFinite(c.maxCallsPerHour) ||
        c.maxCallsPerHour < 0 ||
        !Number.isInteger(c.maxCallsPerHour)
      ) {
        return {
          error:
            "capability-intent: `constraints.maxCallsPerHour` must be a non-negative integer",
        };
      }
    }

    // Configurable count cap (#206): maxCalls + callWindow. Mutually exclusive
    // with maxCallsPerHour so there is exactly one count cap per rule (avoid an
    // ambiguous two-window count gate). Both require the other.
    if (c.maxCalls !== undefined || c.callWindow !== undefined) {
      if (c.maxCallsPerHour !== undefined) {
        return {
          error:
            "capability-intent: `constraints.maxCalls`/`callWindow` cannot be combined with `maxCallsPerHour` (use one count cap)",
        };
      }
      if (c.maxCalls === undefined || c.callWindow === undefined) {
        return {
          error:
            "capability-intent: `constraints.maxCalls` and `constraints.callWindow` must be set together",
        };
      }
      if (!isNonNegInt(c.maxCalls)) {
        return {
          error:
            "capability-intent: `constraints.maxCalls` must be a non-negative integer",
        };
      }
      if (
        typeof c.callWindow !== "string" ||
        parseIso8601DurationSeconds(c.callWindow) === null
      ) {
        return {
          error:
            "capability-intent: `constraints.callWindow` must be a positive ISO-8601 duration (e.g. PT1H, P1D)",
        };
      }
    }

    // Cumulative spend cap (#206).
    if (c.cumulativeSpend !== undefined) {
      const cs = c.cumulativeSpend;
      if (!isPlainObject(cs)) {
        return {
          error:
            "capability-intent: `constraints.cumulativeSpend` must be an object",
        };
      }
      const unknownCs = Object.keys(cs).filter(
        (k) => !ALLOWED_CUMULATIVE_SPEND_KEYS.has(k),
      );
      if (unknownCs.length > 0) {
        return {
          error: `capability-intent: unknown constraints.cumulativeSpend key(s): ${unknownCs.join(", ")}`,
        };
      }
      if (
        typeof cs.window !== "string" ||
        parseIso8601DurationSeconds(cs.window) === null
      ) {
        return {
          error:
            "capability-intent: `cumulativeSpend.window` must be a positive ISO-8601 duration (e.g. PT24H, P1D)",
        };
      }
      if (typeof cs.currency !== "string" || cs.currency.length === 0) {
        return {
          error:
            "capability-intent: `cumulativeSpend.currency` must be a non-empty string",
        };
      }
      if (!isNonNegInt(cs.max)) {
        return {
          error:
            "capability-intent: `cumulativeSpend.max` must be a non-negative integer (minor units; no floats)",
        };
      }
      if (
        typeof cs.aggregateOver !== "string" ||
        !CUMULATIVE_SPEND_SCOPES.has(cs.aggregateOver)
      ) {
        return {
          error:
            'capability-intent: `cumulativeSpend.aggregateOver` must be "operation" | "agent" | "grant"',
        };
      }
    }

    if (c.argEquals !== undefined && !isStringRecord(c.argEquals)) {
      return {
        error:
          "capability-intent: `constraints.argEquals` must be Record<string,string>",
      };
    }
    if (c.argMatches !== undefined && !isStringRecord(c.argMatches)) {
      return {
        error:
          "capability-intent: `constraints.argMatches` must be Record<string,string>",
      };
    }
    if (
      c.argArraySubset !== undefined &&
      !isStringArrayRecord(c.argArraySubset)
    ) {
      return {
        error:
          "capability-intent: `constraints.argArraySubset` must be Record<string,string[]>",
      };
    }
    // SEC-107: bound operator-supplied regexes at store/parse time, not just at
    // evaluation time, so a pathological pattern fails closed as a config error.
    if (
      c.argMatches !== undefined &&
      Object.values(c.argMatches as Record<string, string>).some(
        (p) => p.length > MAX_POLICY_PATTERN_LENGTH,
      )
    ) {
      return {
        error: `capability-intent: \`constraints.argMatches\` patterns must not exceed ${MAX_POLICY_PATTERN_LENGTH} chars`,
      };
    }

    let timeWindow: CapabilityTimeWindow | undefined;
    if (c.timeWindow !== undefined) {
      const parsedTimeWindow = parseTimeWindow(c.timeWindow);
      if ("error" in parsedTimeWindow) return parsedTimeWindow;
      timeWindow = parsedTimeWindow;
    }

    let xConstraints: XConstraints | undefined;
    if (c.x !== undefined) {
      const parsedX = parseXConstraints(c.x);
      if ("error" in parsedX) return { error: parsedX.error };
      xConstraints = parsedX;
    }

    constraints = {
      ...(c.maxCallsPerHour !== undefined
        ? { maxCallsPerHour: c.maxCallsPerHour as number }
        : {}),
      ...(c.maxCalls !== undefined ? { maxCalls: c.maxCalls as number } : {}),
      ...(c.callWindow !== undefined
        ? { callWindow: c.callWindow as string }
        : {}),
      ...(c.cumulativeSpend !== undefined
        ? {
            cumulativeSpend: {
              window: (c.cumulativeSpend as Record<string, unknown>)
                .window as string,
              currency: (c.cumulativeSpend as Record<string, unknown>)
                .currency as string,
              max: (c.cumulativeSpend as Record<string, unknown>).max as number,
              aggregateOver: (c.cumulativeSpend as Record<string, unknown>)
                .aggregateOver as CumulativeSpendScope,
            },
          }
        : {}),
      ...(c.argEquals !== undefined
        ? { argEquals: c.argEquals as Record<string, string> }
        : {}),
      ...(c.argMatches !== undefined
        ? { argMatches: c.argMatches as Record<string, string> }
        : {}),
      ...(c.argArraySubset !== undefined
        ? { argArraySubset: c.argArraySubset as Record<string, string[]> }
        : {}),
      ...(timeWindow !== undefined ? { timeWindow } : {}),
      ...(xConstraints !== undefined ? { x: xConstraints } : {}),
    };
  }

  return {
    capabilities: capabilities as string[],
    effect,
    ...(constraints !== undefined ? { constraints } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isStringArrayRecord(
  value: unknown,
): value is Record<string, string[]> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length <= MAX_ARG_ARRAY_VALUES &&
      entry.every(
        (item) =>
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= MAX_ARG_ARRAY_VALUE_LENGTH,
      ),
  );
}

/**
 * Test-only re-export of the internal config parser + duration parser so the
 * store-time (write-path) validation can be asserted directly. NOT part of the
 * runtime decision surface; the composers call the internal `parseConfig`.
 */
export function parseCapabilityIntentConfigForTest(
  rawInput: unknown,
): CapabilityIntentConfig | { error: string } {
  return parseConfig(rawInput);
}
export function parseIso8601DurationSecondsForTest(
  input: unknown,
): number | null {
  return parseIso8601DurationSeconds(input);
}

/**
 * Evaluate the constraints on an `effect: "allow"` match. Returns a deny result
 * on the FIRST failed constraint, or `null` when every constraint holds.
 */
function evaluateConstraints(
  base: { policyId: string; type: string },
  constraints: CapabilityIntentConstraints,
  capability: NonNullable<EvaluatorContext["capability"]>,
  ctx: EvaluatorContext,
): ContributedPolicyResult | null {
  const { args } = capability;

  // argEquals: every key must exist and strictly equal the configured string.
  if (constraints.argEquals) {
    for (const [key, expected] of Object.entries(constraints.argEquals)) {
      if (!Object.hasOwn(args, key)) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: required arg "${key}" is absent`,
        };
      }
      if (args[key] !== expected) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: arg "${key}" must equal "${expected}"`,
        };
      }
    }
  }

  // argMatches: every key must exist, be a string, and match the (defensively
  // compiled) regex. Invalid regex in config => deny (never throw).
  if (constraints.argMatches) {
    for (const [key, pattern] of Object.entries(constraints.argMatches)) {
      // SEC-107: cap the operator-supplied pattern length so a pathological
      // regex cannot be smuggled in via config.
      if (
        typeof pattern !== "string" ||
        pattern.length > MAX_POLICY_PATTERN_LENGTH
      ) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: regex for arg "${key}" missing or exceeds ${MAX_POLICY_PATTERN_LENGTH} chars`,
        };
      }
      let re: RE2;
      try {
        // anchor full-string so a partial match can't slip a governed arg.
        re = new RE2(`^(?:${pattern})$`, "u");
      } catch {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: invalid regex for arg "${key}" in config`,
        };
      }
      if (!Object.hasOwn(args, key)) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: required arg "${key}" is absent`,
        };
      }
      const value = args[key];
      // SEC-107: cap the agent-controlled input the regex runs against; an
      // oversized arg cannot be verified within the bound => deny.
      if (
        typeof value === "string" &&
        value.length > MAX_POLICY_PATTERN_INPUT_LENGTH
      ) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: arg "${key}" exceeds the ${MAX_POLICY_PATTERN_INPUT_LENGTH}-char match input cap`,
        };
      }
      if (typeof value !== "string" || !re.test(value)) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: arg "${key}" does not match required pattern`,
        };
      }
    }
  }
  if (constraints.argArraySubset) {
    for (const [key, allowedValues] of Object.entries(
      constraints.argArraySubset,
    )) {
      const value = args[key];
      const allowed = new Set(allowedValues);
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_ARG_ARRAY_VALUES ||
        !value.every(
          (item) =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= MAX_ARG_ARRAY_VALUE_LENGTH &&
            allowed.has(item),
        )
      ) {
        return {
          ...base,
          passed: false,
          reason: `capability-intent: every value of arg "${key}" must belong to its configured allowlist`,
        };
      }
    }
  }
  if (constraints.timeWindow) {
    const result = timeWindowAllows(
      constraints.timeWindow,
      capability.evaluatedAt,
    );
    if (result !== "allow") {
      return {
        ...base,
        passed: false,
        reason:
          result === "unavailable"
            ? "capability-intent: timeWindow set but server evaluation time is unavailable"
            : "capability-intent: invoke is outside the configured business-hours window",
      };
    }
  }

  // Configurable count cap + cumulativeSpend (#206) are evaluated ONLY on the
  // provider-action plane (composeProviderActionPolicyDecision), which wires the
  // windowed count + spend aggregate + operation spend declaration. The legacy
  // EvaluatorContext (tx-sign path) carries none of those signals, so a rule
  // that declares them here CANNOT be evaluated => FAIL CLOSED (deny), never a
  // silent pass. This mirrors the missing-signal discipline of maxCallsPerHour.
  if (
    constraints.maxCalls !== undefined ||
    constraints.callWindow !== undefined
  ) {
    return {
      ...base,
      passed: false,
      reason:
        "capability-intent: maxCalls/callWindow requires the provider-action plane (windowed invoke count not wired on this path)",
    };
  }
  if (constraints.cumulativeSpend !== undefined) {
    return {
      ...base,
      passed: false,
      reason:
        "capability-intent: cumulativeSpend requires the provider-action plane (spend aggregate not wired on this path)",
    };
  }

  // maxCallsPerHour: evaluate against the capability-invoke counter. Absent
  // count => DENY (fail closed): we never borrow the tx counter and never
  // silently pass a rate cap.
  if (constraints.maxCallsPerHour !== undefined) {
    const count = ctx.capabilityInvokeCount1h;
    if (typeof count !== "number" || !Number.isFinite(count)) {
      return {
        ...base,
        passed: false,
        reason:
          "capability-intent: maxCallsPerHour set but capabilityInvokeCount1h is absent (invoke count not wired)",
      };
    }
    if (count >= constraints.maxCallsPerHour) {
      return {
        ...base,
        passed: false,
        reason: `capability-intent: hourly invoke cap reached (${constraints.maxCallsPerHour})`,
      };
    }
  }

  return null;
}

/**
 * The `capability-intent` evaluator. See the file header for the full semantics.
 */
export function evaluateCapabilityIntent(
  rule: ContributedPolicyRule,
  ctx: EvaluatorContext,
): ContributedPolicyResult {
  const base = { policyId: rule.id, type: rule.type };

  // 1. Not a capability invoke -> inert (cannot interfere with tx signing).
  if (!ctx.capability) {
    return { ...base, passed: true, reason: "not a capability invoke" };
  }

  // 2. Config must be well-formed (fail closed).
  const parsed = parseConfig(rule.config);
  if ("error" in parsed) {
    // SEC-181: same malformed-input precedence as both composers — a malformed
    // rule whose selector is well-formed and provably scoped to a DIFFERENT
    // capability is not governing this invoke and stays inert. Only a
    // malformed GOVERNING rule, or one whose selector is unrecoverable
    // (ambiguous scope), denies.
    const sel = recoverSelectorMatch(rule.config, ctx.capability.name);
    if (sel.recoverable && !sel.matches) {
      return {
        ...base,
        passed: true,
        reason: `capability "${ctx.capability.name}" not governed by this rule`,
      };
    }
    return { ...base, passed: false, reason: parsed.error };
  }

  const { name } = ctx.capability;

  // 3. This rule only governs the capabilities it names. A non-match is NOT
  //    APPLICABLE -> pass (the invoke layer's default-deny handles ungoverned
  //    capabilities; a plain "no matching allow" is NOT this rule's job to deny).
  if (!capabilityMatches(parsed, name)) {
    return {
      ...base,
      passed: true,
      reason: `capability "${name}" not governed by this rule`,
    };
  }

  // 4. Matched. Apply the effect.
  switch (parsed.effect) {
    case "deny":
      return {
        ...base,
        passed: false,
        reason: `capability-intent: capability "${name}" is denied by policy`,
      };
    case "require-approval":
      return {
        ...base,
        passed: false,
        // the engine honours this via ManualApprovalSignal (see manual-approval.ts):
        // a non-passing result carrying requiresManualApproval routes to the queue.
        requiresManualApproval: true,
        reason: `capability-intent: capability "${name}" requires manual approval`,
      } as ContributedPolicyResult;
    case "allow": {
      if (parsed.constraints) {
        const denial = evaluateConstraints(
          base,
          parsed.constraints,
          ctx.capability,
          ctx,
        );
        if (denial) return denial;
      }
      return {
        ...base,
        passed: true,
        reason: `capability-intent: capability "${name}" allowed`,
      };
    }
  }
}

/**
 * The composed decision over a set of `capability-intent` rules that GOVERN a
 * single invoked capability, in the canonical precedence order.
 *
 * Canonical provider-action composition:
 *   1. a malformed/unknown rule config that GOVERNS this capability, or whose
 *      SELECTOR is unrecoverable (ambiguous scope), or an unavailable policy
 *      input => HARD DENY
 *   2. any matching hard deny (an `effect: "deny"` match, OR an `effect: "allow"`
 *      match that FAILS a hard constraint, OR a thrown evaluator error) => HARD
 *      DENY
 *   3. else any matching `require-approval` => APPROVAL REQUIRED
 *   4. else any matching passing `allow` => ALLOW
 *   5. else (no governing rule matched/passed) => HARD DENY / no governing allow
 *
 * MALFORMED-INPUT PRECEDENCE IS SCOPED TO GOVERNING RULES (master-plan §5.3).
 * A malformed rule config does NOT automatically brick every invoke: if the
 * rule's `capabilities` SELECTOR is well-formed and provably scoped to a
 * DIFFERENT capability, the rule is not governing this request and stays inert
 * even though the rest of its config is broken. Only a malformed rule that (a)
 * governs THIS capability, or (b) has an UNRECOVERABLE selector (so its scope
 * cannot be determined) => HARD DENY. Ambiguous scope fails closed.
 *
 * This is the single source of truth for capability-intent precedence. It FIXES
 * the prior invoke-layer bug where a passing allow could short-circuit an
 * applicable require-approval (allow-over-approval). A malformed governing
 * config, a failed hard constraint, or a thrown evaluator error can NEVER be
 * softened into an approval, and can never surface as a 500.
 *
 * The caller supplies ONLY the rules that already govern the invoked capability
 * (i.e. their `capabilities` list matches the name). Passing non-governing rules
 * is harmless — they evaluate as "not applicable" (pass) and are ignored — but
 * the effective default-deny (outcome 5) is defined over the GOVERNING set, so
 * the caller must not filter out governing rules before composing.
 */
export type CapabilityIntentCompositionEffect =
  | "hard_deny"
  | "approval_required"
  | "allow";

export interface CapabilityIntentCompositionResult {
  readonly effect: CapabilityIntentCompositionEffect;
  readonly reason: string;
}

export function composeCapabilityIntentDecision(
  rules: readonly ContributedPolicyRule[],
  ctx: EvaluatorContext,
): CapabilityIntentCompositionResult {
  // Not a capability invoke at all: nothing to compose. Fail closed — the invoke
  // layer must only call this on an actual capability invoke with ctx.capability.
  if (!ctx.capability) {
    return {
      effect: "hard_deny",
      reason: "capability-intent: not a capability invoke",
    };
  }
  const { name } = ctx.capability;

  let approvalReason: string | undefined;
  let allowReason: string | undefined;

  for (const rule of rules) {
    // A DISABLED rule is inert, matching `evaluatePolicy`/`PolicyEngine`
    // semantics (any FALSY `enabled` => skipped, mirroring the generic engine's
    // `!rule.enabled` check — `false`, `undefined`, `null`, `0`, `""` all mean
    // "off"). Disabling a policy must reliably turn it off for every caller of
    // this exported helper — a disabled deny/require-approval (or even a disabled
    // malformed) rule must NOT block, queue, or hard-deny. We skip it BEFORE
    // parsing so a disabled-but-malformed rule cannot fail the composition closed
    // either.
    if (!rule.enabled) continue;

    // Evaluate this rule defensively. The whole per-rule body — parse, selector
    // recovery, and evaluation — is wrapped so that NOTHING it does can throw out
    // of the helper. A thrown error (a hostile jsonb getter, an evaluator bug,
    // anything) is treated exactly like a malformed config: fail closed on the
    // GOVERNING scope, never a 500, never an approval. `result === null` means
    // the rule was inert (non-governing / provably scoped elsewhere) and
    // contributes nothing.
    let result: ContributedPolicyResult | null;
    try {
      // Parse the config. A malformed/unknown config CANNOT simply hard-deny
      // every invoke: malformed-input precedence applies to GOVERNING rules only
      // (master-plan §5.3). A rule scoped (by a well-formed selector) to a
      // DIFFERENT capability is not governing this request and must stay inert
      // even if the rest of its config is broken. But if the selector itself is
      // unrecoverable, we cannot prove the rule is non-governing, so fail closed.
      const parsed = parseConfig(rule.config);
      if ("error" in parsed) {
        // Separate SELECTOR recovery from full-config validation.
        const sel = recoverSelectorMatch(rule.config, name);
        if (sel.recoverable && !sel.matches) {
          // Well-formed selector, provably scoped elsewhere => inert. The
          // malformed remainder cannot affect a capability this rule doesn't
          // govern.
          continue;
        }
        // Either the selector matches THIS capability (malformed governing rule)
        // or the selector is unrecoverable (ambiguous scope). Both HARD DENY and
        // short-circuit — a broken governing gate must never be silently dropped
        // and must never be softened into an approval.
        return { effect: "hard_deny", reason: parsed.error };
      }

      // Only rules that govern THIS capability contribute. A non-match is inert.
      if (!capabilityMatches(parsed, name)) {
        result = null;
      } else {
        result = evaluateCapabilityIntent(
          {
            id: rule.id,
            type: rule.type,
            enabled: rule.enabled,
            config: rule.config,
          },
          ctx,
        );
      }
    } catch (err) {
      // A throw anywhere in the per-rule body. Scope it: if the selector is
      // recoverable and demonstrably elsewhere, the throw touched a non-governing
      // rule and is inert. Otherwise fail closed on the governing/ambiguous rule.
      let scopedElsewhere = false;
      try {
        const sel = recoverSelectorMatch(rule.config, name);
        scopedElsewhere = sel.recoverable && !sel.matches;
      } catch {
        scopedElsewhere = false;
      }
      if (scopedElsewhere) continue;
      // describeThrown NEVER throws for any hostile value (throwing
      // toString/valueOf/Symbol.toPrimitive, Proxy message getter, etc.), so
      // building this fail-closed reason cannot itself unwind past the return.
      return {
        effect: "hard_deny",
        reason: `capability-intent: evaluator error for capability "${name}" (${describeThrown(
          err,
        )})`,
      };
    }

    // Inert rule (non-governing / scoped elsewhere): contributes nothing.
    if (result === null) continue;

    // A matching require-approval fails without passing and carries the flag.
    if (result.requiresManualApproval === true && result.passed === false) {
      // Remember it, but keep scanning: a later hard deny must still win.
      if (approvalReason === undefined) {
        approvalReason =
          result.reason ??
          `capability-intent: capability "${name}" requires manual approval`;
      }
      continue;
    }

    // A matching rule that did NOT pass and is NOT an approval is a HARD DENY.
    // This covers both an `effect: "deny"` match and an `effect: "allow"` match
    // that failed a hard constraint (arg/regex/rate). Deny wins immediately.
    if (result.passed === false) {
      return {
        effect: "hard_deny",
        reason:
          result.reason ??
          `capability-intent: capability "${name}" denied by policy`,
      };
    }

    // A matching passing allow. Record it, but do NOT return yet: an approval or
    // a hard deny from another governing rule must be able to override it.
    if (allowReason === undefined) {
      allowReason =
        result.reason ?? `capability-intent: capability "${name}" allowed`;
    }
  }

  // No hard deny was seen. Approval outranks allow.
  if (approvalReason !== undefined) {
    return { effect: "approval_required", reason: approvalReason };
  }
  if (allowReason !== undefined) {
    return { effect: "allow", reason: allowReason };
  }

  // No governing rule matched with a passing allow => effective default-deny.
  return {
    effect: "hard_deny",
    reason: `capability-intent: no policy authorizes capability "${name}"`,
  };
}

/**
 * The `capability-intent` rule as a {@link PolicyRuleContribution}, ready for the
 * W-1a plugin to register via the plugin host with zero rework. Bound to the
 * policy engine's {@link EvaluatorContext}.
 */
export const capabilityIntentContribution: PolicyRuleContribution<EvaluatorContext> =
  {
    type: CAPABILITY_INTENT_RULE_TYPE,
    description:
      "gate a named capability invoke: allow / deny / require-approval + arg and hourly-invoke constraints (fail-closed)",
    evaluate: evaluateCapabilityIntent,
  };

// ─── Provider-action policy composition ───────────────────────────────────────
//
// The legacy invoke.ts loop lets a passing allow win even when another rule
// simultaneously requires approval (origin/develop invoke.ts:288-311). That is
// an obligation-laundering bug: a required approval must NEVER be dropped by a
// separate matching allow. `composeProviderActionPolicyDecision` centralizes the
// correct precedence for the PROVIDER-ACTION (authority) plane:
//
//   malformed/unknown input or any matching deny/failed hard constraint => hard_deny
//   else any matching require-approval                                    => approval_required
//   else any matching passing allow                                        => allow
//   else                                                                   => hard_deny (POLICY_NO_GOVERNING_ALLOW)
//
// Conditions here are applicability-only (which rules govern this operation);
// they never emit approval/MFA/rate obligations from the access layer. A thrown
// evaluator error is hard_deny, never approval.

/** Stable provider-policy reason codes (mirror the spec deny table). */
export const PROVIDER_POLICY_REASON = {
  ALLOW: "POLICY_ALLOW",
  NO_GOVERNING_ALLOW: "POLICY_NO_GOVERNING_ALLOW",
  HARD_DENY: "POLICY_HARD_DENY",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  CONFIGURATION_INVALID: "POLICY_CONFIGURATION_INVALID",
  INPUT_UNAVAILABLE: "POLICY_INPUT_UNAVAILABLE",
  EVALUATOR_ERROR: "POLICY_EVALUATOR_ERROR",
  // Permissioned-X reason codes (see docs/security/permissioned-x.mdx).
  X_REPLY_NOT_SUMMONED: "POLICY_X_REPLY_NOT_SUMMONED",
  X_REPLY_FORBIDDEN: "POLICY_X_REPLY_FORBIDDEN",
  X_URL_FORBIDDEN: "POLICY_X_URL_FORBIDDEN",
  X_CONTENT_TOO_LONG: "POLICY_X_CONTENT_TOO_LONG",
  X_CONTENT_BLOCKED: "POLICY_X_CONTENT_BLOCKED",
  X_RATE_CAP_EXCEEDED: "POLICY_X_RATE_CAP_EXCEEDED",
  X_SPEND_CAP_EXCEEDED: "POLICY_X_SPEND_CAP_EXCEEDED",
  X_QUIET_HOURS: "POLICY_X_QUIET_HOURS",
  // Cumulative-spend cap reason codes (#206). Bounded, stable set (no unbounded
  // labels): one for the breach, one for a missing declared spend field, one for
  // a currency mismatch. Missing aggregate context reuses INPUT_UNAVAILABLE and a
  // malformed config reuses CONFIGURATION_INVALID (the house allowlist already
  // carries both), so no new labels are minted for those.
  CUMULATIVE_SPEND_CAP_EXCEEDED: "POLICY_CUMULATIVE_SPEND_CAP_EXCEEDED",
  CUMULATIVE_SPEND_NO_SPEND_FIELD: "POLICY_CUMULATIVE_SPEND_NO_SPEND_FIELD",
  CUMULATIVE_SPEND_CURRENCY_MISMATCH:
    "POLICY_CUMULATIVE_SPEND_CURRENCY_MISMATCH",
} as const;

export type ProviderPolicyEffect = "hard_deny" | "approval_required" | "allow";

/** Adapter-derived, validated inputs a provider policy may read. It does NOT
 *  lift arbitrary scalar fields from raw JSON: only the operation key, the
 *  adapter-validated arguments, canonical method/host/path, and the
 *  authoritative trailing-hour invoke count. */
export interface ProviderPolicyContext {
  readonly operationKey: string;
  readonly args: Record<string, unknown>;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** Immutable server-supplied evaluation instant. Never accepted from action args. */
  readonly evaluatedAt?: string;
  /** Authoritative trailing-hour invoke count. `undefined` => input
   *  unavailable => fail closed (hard_deny, POLICY_INPUT_UNAVAILABLE). */
  readonly invokeCount1h?: number;
  /**
   * Authoritative invoke counts for configurable count caps (#206), keyed by the
   * per-cap bucket key ({@link windowedInvokeBucketKey}: window+max). Two
   * `maxCalls` rules with DIFFERENT windows each read their OWN count, so a daily
   * cap can never be evaluated against an hourly count (codex P2). A missing
   * entry for a rule's bucket => fail closed (POLICY_INPUT_UNAVAILABLE). Kept
   * separate from `invokeCount1h` so the hardcoded-hour cap and the configurable
   * caps never borrow each other's counter.
   */
  readonly windowedInvokeCounts?: Readonly<Record<string, number>>;
  /**
   * IN-MEMORY-ONLY tweet text for `contentPolicy.blockedPatterns` matching.
   * Deliberately NOT part of {@link args} (which is validated scalars only) and
   * NEVER persisted. `undefined` for non-text operations; a blockedPatterns rule
   * then fails closed (POLICY_INPUT_UNAVAILABLE). See
   * docs/security/permissioned-x.mdx "Text availability".
   */
  readonly policyText?: string;
  /**
   * Permissioned-X authoritative inputs. Each is `undefined` when unwired; a
   * policy that REQUIRES the input then fails closed (POLICY_INPUT_UNAVAILABLE).
   * Steward never borrows a different counter or silently passes.
   */
  readonly x?: {
    /** authoritative count of posts already made in the policy's trailing
     *  window (used by maxPostsPerWindow). */
    readonly postsInWindow?: number;
    /** authoritative accumulated estimated micro-dollar spend in the window
     *  (used by spendPolicy; the current action's cost is added on top). */
    readonly accumulatedSpendMicros?: number;
    /** authoritative current minute-of-day UTC, 0..1439 (used by quietHours). */
    readonly nowMinuteUtc?: number;
    /** adapter-derived "the post is a reply" signal (replyPolicy). PREFERRED
     *  over the same-named `args` entry, which is caller-influenced (SEC-182). */
    readonly isReply?: boolean;
    /** authoritative "the user summoned the agent" signal (replyPolicy
     *  summoned-only). It must come from an authenticated adapter lookup, not a
     *  caller assertion (SEC-182). */
    readonly summoned?: boolean;
    /** adapter-derived "the post body contains a URL" signal (allowUrls /
     *  spend / escalation policies). PREFERRED over `args` (SEC-182). */
    readonly hasUrl?: boolean;
    /** adapter-counted code-point length of the post text (maxLength).
     *  PREFERRED over `args` (SEC-182). */
    readonly textCodePointLength?: number;
  };
  /**
   * The operation's DECLARED spend field (#206). The operation - not the caller
   * - declares which validated `policyArgs` field carries the per-invoke spend
   * amount and what currency it is denominated in. The composer reads the amount
   * ONLY from `args[spendDeclaration.field]` (validated scalars, never raw JSON).
   *
   * `undefined` => the operation declares NO spend field. A `cumulativeSpend`
   * rule on such an operation cannot be evaluated => DENY
   * (POLICY_CUMULATIVE_SPEND_NO_SPEND_FIELD), never skipped. Operations that
   * cannot move money simply never carry a declaration and so can never be
   * governed by a spend cap by accident.
   */
  readonly spendDeclaration?: {
    /** the `policyArgs` key holding the integer minor-unit spend amount. */
    readonly field: string;
    /** the currency/asset tag this amount is denominated in (verbatim compare). */
    readonly currency: string;
  };
  /**
   * Authoritative trailing-window spend aggregates (#206), keyed by a stable
   * per-cap BUCKET key (see {@link cumulativeSpendBucketKey}). Each entry is the
   * ALREADY-COMMITTED (or reserved-and-committed) integer minor-unit sum over the
   * rule's trailing window for that exact cap, in the operation's currency. The
   * composer adds THIS invoke's spend on top and compares against the cap.
   *
   * Keying by the FULL cap identity (scope + window + max + currency), NOT just
   * the scope, lets two rules that share a scope but declare DIFFERENT windows /
   * caps each read their OWN trailing-window sum - they never share a bucket, so
   * the same invoke is never double-counted across distinct caps (codex P2).
   *
   * A missing entry for a rule's bucket => the aggregate is not wired for that
   * cap => DENY (POLICY_INPUT_UNAVAILABLE). Steward never assumes a zero prior
   * sum: an absent aggregate is a missing signal, not an empty window. The invoke
   * layer supplies exactly the buckets its governing rules request, computed
   * under the atomic reservation discipline so two concurrent invokes cannot both
   * pass when their sum exceeds the cap.
   */
  readonly cumulativeSpend?: Readonly<Record<string, number>>;
}

/**
 * Stable bucket key for a cumulativeSpend cap. Uniquely identifies the trailing-
 * window aggregate a specific cap reads: two rules with the SAME scope but a
 * different window or max (or currency) get DIFFERENT keys and therefore
 * INDEPENDENT sums (no shared double-count). Callers (the invoke layer) MUST use
 * this same function to key the sums they supply on `ctx.cumulativeSpend`.
 */
export function cumulativeSpendBucketKey(cap: {
  aggregateOver: CumulativeSpendScope;
  windowSeconds: number;
  max: number;
  currency: string;
}): string {
  return `${cap.aggregateOver}:${cap.windowSeconds}:${cap.max}:${cap.currency}`;
}

/**
 * Stable bucket key for a configurable count cap (maxCalls). Two maxCalls rules
 * with different windows (or maxes) get different keys and therefore independent
 * counts. Callers (the invoke layer) MUST use this to key `windowedInvokeCounts`.
 */
export function windowedInvokeBucketKey(cap: {
  windowSeconds: number;
  max: number;
}): string {
  return `${cap.windowSeconds}:${cap.max}`;
}

export interface ProviderPolicyRuleResult {
  readonly policyId: string;
  readonly policyType: "capability-intent";
  readonly applicable: true;
  readonly configuredEffect: CapabilityIntentEffect;
  readonly outcome: "pass" | "hard_deny" | "approval_required";
  readonly reasonCode: string;
  /** JCS hash of {id,type,enabled,config}; filled by the caller which owns the
   *  hashing dependency. Left as a stable placeholder here. */
  readonly ruleRevisionHash: string;
}

export interface ProviderPolicyEvaluationV1 {
  readonly effect: ProviderPolicyEffect;
  readonly reasonCodes: string[];
  readonly results: ProviderPolicyRuleResult[];
}

/** The subset of a capability-intent rule the provider composer needs. */
export interface ProviderPolicyRule {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

/**
 * Compose a provider-action policy decision from the governing capability-intent
 * rules. Only enabled `capability-intent` rules that name the operation key are
 * applicable. Precedence is strictly hard_deny > approval_required > allow >
 * default-deny. Never throws for a policy reason: an unexpected internal error
 * becomes hard_deny/POLICY_EVALUATOR_ERROR.
 *
 * NAMING / COEXISTENCE WITH THE LEGACY-PLANE FIX (#187, merged on develop):
 * `composeCapabilityIntentDecision(rules, ctx)` (above) fixes the SAME
 * allow-over-approval precedence bug for the LEGACY invoke.ts plane, reusing
 * `ContributedPolicyRule`/`EvaluatorContext` and returning a
 * `CapabilityIntentCompositionResult`. This function is the AUTHORITY-plane analog
 * required by the provider-action contract: it returns the full `ProviderPolicyEvaluationV1`
 * document (per-rule results with configured effect / outcome / reason code) that
 * the provider-action service persists as an immutable policy decision. The two
 * are deliberately distinct exports; both enforce identical precedence
 * (hard_deny > approval_required > allow > default-deny).
 */
export function composeProviderActionPolicyDecision(
  rules: ReadonlyArray<ProviderPolicyRule>,
  context: ProviderPolicyContext,
): ProviderPolicyEvaluationV1 {
  try {
    const results: ProviderPolicyRuleResult[] = [];
    let sawHardDeny = false;
    let sawApproval = false;
    let sawPassingAllow = false;
    const reasonCodes = new Set<string>();

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.type !== CAPABILITY_INTENT_RULE_TYPE) {
        // An unknown/foreign governing rule type is not something we can reason
        // about safely -> hard deny (fail closed).
        sawHardDeny = true;
        reasonCodes.add(PROVIDER_POLICY_REASON.CONFIGURATION_INVALID);
        results.push({
          policyId: rule.id,
          policyType: "capability-intent",
          applicable: true,
          configuredEffect: "deny",
          outcome: "hard_deny",
          reasonCode: PROVIDER_POLICY_REASON.CONFIGURATION_INVALID,
          ruleRevisionHash: "",
        });
        continue;
      }

      const parsed = parseConfig(rule.config);
      if ("error" in parsed) {
        // SEC-181: malformed-input precedence is scoped to GOVERNING rules,
        // matching the legacy-plane composer (composeCapabilityIntentDecision)
        // and master-plan §5.3. A well-formed selector provably scoped to a
        // DIFFERENT operation stays inert even though the rest of the config
        // is broken; only a malformed rule that governs THIS operation, or
        // whose selector is unrecoverable (ambiguous scope), hard-denies.
        const sel = recoverSelectorMatch(rule.config, context.operationKey);
        if (sel.recoverable && !sel.matches) continue;
        sawHardDeny = true;
        reasonCodes.add(PROVIDER_POLICY_REASON.CONFIGURATION_INVALID);
        results.push({
          policyId: rule.id,
          policyType: "capability-intent",
          applicable: true,
          configuredEffect: "deny",
          outcome: "hard_deny",
          reasonCode: PROVIDER_POLICY_REASON.CONFIGURATION_INVALID,
          ruleRevisionHash: "",
        });
        continue;
      }

      // Not applicable: a rule that does not name this operation key is silent.
      if (!capabilityMatches(parsed, context.operationKey)) continue;

      if (parsed.effect === "deny") {
        sawHardDeny = true;
        reasonCodes.add(PROVIDER_POLICY_REASON.HARD_DENY);
        results.push(
          mkResult(
            rule.id,
            "deny",
            "hard_deny",
            PROVIDER_POLICY_REASON.HARD_DENY,
          ),
        );
        continue;
      }

      if (parsed.effect === "require-approval") {
        sawApproval = true;
        reasonCodes.add(PROVIDER_POLICY_REASON.APPROVAL_REQUIRED);
        results.push(
          mkResult(
            rule.id,
            "require-approval",
            "approval_required",
            PROVIDER_POLICY_REASON.APPROVAL_REQUIRED,
          ),
        );
        continue;
      }

      // effect === allow: evaluate its hard constraints. A FAILED hard
      // constraint is a hard deny (a rate cap / arg gate is not negotiable via
      // approval). A permissioned-X ESCALATION downgrades the allow to an
      // approval (never softens a deny).
      const denial = evaluateProviderConstraints(parsed.constraints, context);
      if (denial) {
        sawHardDeny = true;
        reasonCodes.add(denial);
        results.push(mkResult(rule.id, "allow", "hard_deny", denial));
        continue;
      }
      const xVerdict = evaluateXConstraints(parsed.constraints?.x, context);
      if (xVerdict.kind === "deny") {
        sawHardDeny = true;
        reasonCodes.add(xVerdict.reasonCode);
        results.push(
          mkResult(rule.id, "allow", "hard_deny", xVerdict.reasonCode),
        );
        continue;
      }
      if (xVerdict.kind === "escalate") {
        sawApproval = true;
        reasonCodes.add(PROVIDER_POLICY_REASON.APPROVAL_REQUIRED);
        results.push(
          mkResult(
            rule.id,
            "allow",
            "approval_required",
            PROVIDER_POLICY_REASON.APPROVAL_REQUIRED,
          ),
        );
        continue;
      }
      sawPassingAllow = true;
      results.push(
        mkResult(rule.id, "allow", "pass", PROVIDER_POLICY_REASON.ALLOW),
      );
    }

    let effect: ProviderPolicyEffect;
    if (sawHardDeny) effect = "hard_deny";
    else if (sawApproval) effect = "approval_required";
    else if (sawPassingAllow) effect = "allow";
    else {
      effect = "hard_deny";
      reasonCodes.add(PROVIDER_POLICY_REASON.NO_GOVERNING_ALLOW);
    }
    return { effect, reasonCodes: [...reasonCodes], results };
  } catch {
    return {
      effect: "hard_deny",
      reasonCodes: [PROVIDER_POLICY_REASON.EVALUATOR_ERROR],
      results: [],
    };
  }
}

function mkResult(
  policyId: string,
  configuredEffect: CapabilityIntentEffect,
  outcome: ProviderPolicyRuleResult["outcome"],
  reasonCode: string,
): ProviderPolicyRuleResult {
  return {
    policyId,
    policyType: "capability-intent",
    applicable: true,
    configuredEffect,
    outcome,
    reasonCode,
    ruleRevisionHash: "",
  };
}

/**
 * Evaluate an allow rule's hard constraints against provider-policy context.
 * Returns a stable reason code on the FIRST failed constraint, or null when all
 * hold. Missing/unavailable invoke count with a rate cap set => input
 * unavailable (fail closed).
 */
function evaluateProviderConstraints(
  constraints: CapabilityIntentConstraints | undefined,
  ctx: ProviderPolicyContext,
): string | null {
  if (!constraints) return null;
  const { args } = ctx;

  if (constraints.argEquals) {
    for (const [key, expected] of Object.entries(constraints.argEquals)) {
      if (!Object.hasOwn(args, key) || args[key] !== expected)
        return PROVIDER_POLICY_REASON.HARD_DENY;
    }
  }
  if (constraints.argMatches) {
    for (const [key, pattern] of Object.entries(constraints.argMatches)) {
      // SEC-107: same ReDoS bounds as the legacy-plane evaluator.
      if (
        typeof pattern !== "string" ||
        pattern.length > MAX_POLICY_PATTERN_LENGTH
      ) {
        return PROVIDER_POLICY_REASON.CONFIGURATION_INVALID;
      }
      let re: RE2;
      try {
        re = new RE2(`^(?:${pattern})$`, "u");
      } catch {
        return PROVIDER_POLICY_REASON.CONFIGURATION_INVALID;
      }
      const value = args[key];
      if (
        typeof value === "string" &&
        value.length > MAX_POLICY_PATTERN_INPUT_LENGTH
      ) {
        return PROVIDER_POLICY_REASON.HARD_DENY;
      }
      if (typeof value !== "string" || !re.test(value))
        return PROVIDER_POLICY_REASON.HARD_DENY;
    }
  }
  if (constraints.argArraySubset) {
    for (const [key, allowedValues] of Object.entries(
      constraints.argArraySubset,
    )) {
      const value = ctx.args[key];
      const allowed = new Set(allowedValues);
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_ARG_ARRAY_VALUES ||
        !value.every(
          (item) =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= MAX_ARG_ARRAY_VALUE_LENGTH &&
            allowed.has(item),
        )
      ) {
        return PROVIDER_POLICY_REASON.HARD_DENY;
      }
    }
  }
  if (constraints.timeWindow) {
    const result = timeWindowAllows(constraints.timeWindow, ctx.evaluatedAt);
    if (result === "unavailable")
      return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
    if (result === "deny") return PROVIDER_POLICY_REASON.HARD_DENY;
  }
  if (constraints.maxCallsPerHour !== undefined) {
    const count = ctx.invokeCount1h;
    if (typeof count !== "number" || !Number.isFinite(count))
      return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
    if (count >= constraints.maxCallsPerHour)
      return PROVIDER_POLICY_REASON.HARD_DENY;
  }

  // Configurable count cap (#206): maxCalls over the trailing callWindow. The
  // invoke layer supplies the count for THIS EXACT cap (window+max) via
  // ctx.windowedInvokeCounts, keyed by windowedInvokeBucketKey - so two maxCalls
  // rules with DIFFERENT windows each read their own count (codex P2). Absent =>
  // fail closed (same discipline as maxCallsPerHour). A malformed callWindow is
  // rejected at store time, but re-validate at runtime so a hand-edited row
  // cannot slip an unbounded window past the gate.
  if (constraints.maxCalls !== undefined) {
    const windowSeconds =
      typeof constraints.callWindow === "string"
        ? parseIso8601DurationSeconds(constraints.callWindow)
        : null;
    if (windowSeconds === null) {
      return PROVIDER_POLICY_REASON.CONFIGURATION_INVALID;
    }
    const counts = ctx.windowedInvokeCounts;
    if (!counts) return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
    const count =
      counts[
        windowedInvokeBucketKey({ windowSeconds, max: constraints.maxCalls })
      ];
    if (typeof count !== "number" || !Number.isFinite(count))
      return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
    if (count >= constraints.maxCalls) return PROVIDER_POLICY_REASON.HARD_DENY;
  }

  // Cumulative spend cap (#206).
  if (constraints.cumulativeSpend !== undefined) {
    const csReason = evaluateCumulativeSpend(constraints.cumulativeSpend, ctx);
    if (csReason) return csReason;
  }
  return null;
}

/**
 * Evaluate a cumulativeSpend cap against the provider-policy context. Returns a
 * stable reason code on failure, or null when the cap holds. FAIL CLOSED in
 * every ambiguous case:
 *   - config window malformed at runtime (hand-edited row)  => CONFIGURATION_INVALID
 *   - operation declares no spend field                      => NO_SPEND_FIELD
 *   - the declared field is absent / not a non-negative int  => INPUT_UNAVAILABLE
 *   - the operation currency != the cap currency (no FX)     => CURRENCY_MISMATCH
 *   - the trailing-window aggregate for the scope is absent   => INPUT_UNAVAILABLE
 *   - projected (aggregate + this spend) > max               => CAP_EXCEEDED
 *
 * Integer math only. `max` and every amount are minor units (micros/cents); the
 * projected sum is computed with Number but every input is a validated safe
 * integer and the comparison is exact for values within Number.MAX_SAFE_INTEGER
 * (guarded below). No floats, no FX.
 */
function evaluateCumulativeSpend(
  cs: CumulativeSpendConstraint,
  ctx: ProviderPolicyContext,
): string | null {
  // Re-validate the window at runtime (store-time already rejected malformed).
  const windowSeconds = parseIso8601DurationSeconds(cs.window);
  if (windowSeconds === null) {
    return PROVIDER_POLICY_REASON.CONFIGURATION_INVALID;
  }
  if (!isNonNegInt(cs.max)) {
    return PROVIDER_POLICY_REASON.CONFIGURATION_INVALID;
  }

  // The operation MUST declare a spend field; otherwise a spend cap cannot be
  // evaluated and the action is denied (never silently skipped).
  const decl = ctx.spendDeclaration;
  if (
    !decl ||
    typeof decl.field !== "string" ||
    typeof decl.currency !== "string"
  ) {
    return PROVIDER_POLICY_REASON.CUMULATIVE_SPEND_NO_SPEND_FIELD;
  }

  // No FX: the operation's spend currency must match the cap's currency exactly.
  if (decl.currency !== cs.currency) {
    return PROVIDER_POLICY_REASON.CUMULATIVE_SPEND_CURRENCY_MISMATCH;
  }

  // Spend derives ONLY from the validated policyArgs field the operation
  // declared - never from raw JSON. Absent / non-integer / negative => fail
  // closed (we cannot price the action, so we cannot let it through a spend cap).
  const rawSpend = Object.hasOwn(ctx.args, decl.field)
    ? ctx.args[decl.field]
    : undefined;
  if (!isNonNegInt(rawSpend)) {
    return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
  }
  const thisSpend = rawSpend;

  // The trailing-window aggregate for THIS cap's bucket (scope+window+max+
  // currency). Absent block OR absent bucket entry => missing signal => deny
  // (never assume a zero window). Keying by the full cap identity means two rules
  // sharing a scope but with different windows/caps never collide.
  const agg = ctx.cumulativeSpend;
  if (!agg) return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
  const bucketKey = cumulativeSpendBucketKey({
    aggregateOver: cs.aggregateOver,
    windowSeconds,
    max: cs.max,
    currency: cs.currency,
  });
  const priorSum = agg[bucketKey];
  if (!isNonNegInt(priorSum)) {
    return PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE;
  }

  // Integer projected sum. Guard against exceeding safe-integer range so the
  // comparison stays exact; an overflow fails closed rather than silently
  // wrapping past the cap.
  const projected = priorSum + thisSpend;
  if (!Number.isSafeInteger(projected)) {
    return PROVIDER_POLICY_REASON.CUMULATIVE_SPEND_CAP_EXCEEDED;
  }
  if (projected > cs.max) {
    return PROVIDER_POLICY_REASON.CUMULATIVE_SPEND_CAP_EXCEEDED;
  }
  return null;
}

// ─── Permissioned-X evaluation ──────────────────────────────────────────

export type XConstraintVerdict =
  | { kind: "pass" }
  | { kind: "deny"; reasonCode: string }
  | { kind: "escalate" };

/**
 * Read X security signals exclusively from the typed, server-populated channel.
 * The generic args bag is caller-influenced, including when no typed channel is
 * present, so it can never be an authority fallback (SEC-182).
 */
function xBoolSignal(
  ctx: ProviderPolicyContext,
  key: "isReply" | "summoned" | "hasUrl",
): boolean | undefined {
  const typed = ctx.x?.[key];
  return typeof typed === "boolean" ? typed : undefined;
}

function xIntegerSignal(
  ctx: ProviderPolicyContext,
  key: "textCodePointLength",
): number | undefined {
  const typed = ctx.x?.[key];
  return typeof typed === "number" && Number.isInteger(typed)
    ? typed
    : undefined;
}

/**
 * Evaluate the permissioned-X constraint sub-block against the provider-policy
 * context. Returns:
 *   - { kind: "deny", reasonCode }  on the FIRST hard failure (deny wins),
 *   - { kind: "escalate" }          when no deny but an escalation condition holds,
 *   - { kind: "pass" }              when the X block is absent or fully satisfied.
 *
 * FAIL CLOSED everywhere: an `x` block on a NON-X operation denies; an
 * unavailable required input denies; an unexpected content shape denies. Deny is
 * evaluated BEFORE escalation so a hard deny can never be softened to approval.
 */
export function evaluateXConstraints(
  x: XConstraints | undefined,
  ctx: ProviderPolicyContext,
): XConstraintVerdict {
  if (!x) return { kind: "pass" };

  // An X policy block only applies to x.* operations. On any other operation it
  // is a configuration error (fail closed) — we never silently ignore it.
  if (!ctx.operationKey.startsWith("x.")) {
    return {
      kind: "deny",
      reasonCode: PROVIDER_POLICY_REASON.CONFIGURATION_INVALID,
    };
  }

  // ── replyPolicy ──
  // A replyPolicy DEPENDS on the `isReply` signal; absent/non-boolean => fail
  // closed (an operation whose build doesn't carry isReply must NOT slip a reply
  // gate). `summoned` is only required when we actually reach the summoned check.
  if (x.replyPolicy) {
    const isReply = xBoolSignal(ctx, "isReply");
    if (isReply === undefined) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
      };
    }
    if (isReply) {
      if (x.replyPolicy.mode === "none") {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.X_REPLY_FORBIDDEN,
        };
      }
      if (x.replyPolicy.mode === "summoned-only") {
        const summoned = xBoolSignal(ctx, "summoned");
        if (summoned === undefined) {
          return {
            kind: "deny",
            reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
          };
        }
        if (!summoned) {
          // The Feb-2026 anti-spam upstream-denial class, modeled locally: an
          // un-summoned programmatic reply would 403 at the wire, so we deny it
          // BEFORE the wasted billed call.
          return {
            kind: "deny",
            reasonCode: PROVIDER_POLICY_REASON.X_REPLY_NOT_SUMMONED,
          };
        }
      }
      // mode === "any": allowed to proceed (operator accepts upstream risk).
    }
    // Not a reply: replyPolicy is inert (it only gates replies).
  }

  // ── contentPolicy ──
  if (x.contentPolicy) {
    // allowUrls DEPENDS on the `hasUrl` signal; absent/non-boolean => fail closed.
    if (x.contentPolicy.allowUrls === false) {
      const hasUrl = xBoolSignal(ctx, "hasUrl");
      if (hasUrl === undefined) {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
        };
      }
      if (hasUrl) {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.X_URL_FORBIDDEN,
        };
      }
    }
    if (x.contentPolicy.maxLength !== undefined) {
      const len = xIntegerSignal(ctx, "textCodePointLength");
      // A content-length policy REQUIRES the length signal. Absent => fail closed.
      if (typeof len !== "number" || !Number.isInteger(len)) {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
        };
      }
      if (len > x.contentPolicy.maxLength) {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.X_CONTENT_TOO_LONG,
        };
      }
    }
    if (
      x.contentPolicy.blockedPatterns &&
      x.contentPolicy.blockedPatterns.length > 0
    ) {
      const text = ctx.policyText;
      // Pattern matching REQUIRES the in-memory text channel. Absent/non-string
      // => fail closed (we cannot prove the content is clean).
      if (typeof text !== "string") {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
        };
      }
      // SEC-107: cap the agent-controlled input the patterns run against; text
      // too large to scan within the bound cannot be proven clean => deny.
      if (text.length > MAX_POLICY_PATTERN_INPUT_LENGTH) {
        return {
          kind: "deny",
          reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
        };
      }
      for (const pattern of x.contentPolicy.blockedPatterns) {
        // SEC-107: cap the operator-supplied pattern length so a pathological
        // regex cannot be smuggled in via config.
        if (
          typeof pattern !== "string" ||
          pattern.length > MAX_POLICY_PATTERN_LENGTH
        ) {
          return {
            kind: "deny",
            reasonCode: PROVIDER_POLICY_REASON.CONFIGURATION_INVALID,
          };
        }
        let re: RE2;
        try {
          re = new RE2(pattern, "u");
        } catch {
          // Invalid regex in config => fail closed (never throw).
          return {
            kind: "deny",
            reasonCode: PROVIDER_POLICY_REASON.CONFIGURATION_INVALID,
          };
        }
        if (re.test(text)) {
          return {
            kind: "deny",
            reasonCode: PROVIDER_POLICY_REASON.X_CONTENT_BLOCKED,
          };
        }
      }
    }
  }

  // ── quietHours ── (gates writes; reads never carry it in practice)
  if (x.quietHours) {
    const now = ctx.x?.nowMinuteUtc;
    if (typeof now !== "number" || !Number.isInteger(now)) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
      };
    }
    const { startMinuteUtc: start, endMinuteUtc: end } = x.quietHours;
    // Non-wrapping window [start, end); wrapping window (start > end) spans
    // midnight so the quiet region is [start, 1440) ∪ [0, end).
    const inWindow =
      start < end ? now >= start && now < end : now >= start || now < end;
    if (inWindow) {
      return { kind: "deny", reasonCode: PROVIDER_POLICY_REASON.X_QUIET_HOURS };
    }
  }

  // ── maxPostsPerWindow ──
  if (x.maxPostsPerWindow) {
    const posts = ctx.x?.postsInWindow;
    if (typeof posts !== "number" || !Number.isFinite(posts)) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
      };
    }
    if (posts >= x.maxPostsPerWindow.max) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.X_RATE_CAP_EXCEEDED,
      };
    }
  }

  // Any spend/URL-escalation policy DEPENDS on the `hasUrl` signal to price the
  // action; absent/non-boolean => fail closed for those policies only.
  const needsHasUrl =
    x.spendPolicy !== undefined ||
    x.escalation?.spendOverMicrosRequiresApproval !== undefined ||
    x.escalation?.urlPostRequiresApproval === true;
  let hasUrl: boolean | undefined;
  if (needsHasUrl) {
    hasUrl = xBoolSignal(ctx, "hasUrl");
    if (hasUrl === undefined) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
      };
    }
  }

  // ── spendPolicy (hard cap over estimated spend) ──
  // Estimated spend = accumulated window spend + this action's price.
  let projectedMicros: number | undefined;
  if (
    x.spendPolicy ||
    x.escalation?.spendOverMicrosRequiresApproval !== undefined
  ) {
    const accumulated = ctx.x?.accumulatedSpendMicros;
    if (typeof accumulated !== "number" || !Number.isFinite(accumulated)) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.INPUT_UNAVAILABLE,
      };
    }
    // hasUrl is guaranteed defined here (needsHasUrl covers both branches).
    projectedMicros = accumulated + estimateXPostMicros(hasUrl === true);
  }
  if (x.spendPolicy && projectedMicros !== undefined) {
    if (projectedMicros > x.spendPolicy.maxSpendMicros) {
      return {
        kind: "deny",
        reasonCode: PROVIDER_POLICY_REASON.X_SPEND_CAP_EXCEEDED,
      };
    }
  }

  // ── escalation (only reached when NO hard deny fired) ──
  if (x.escalation) {
    if (x.escalation.urlPostRequiresApproval === true && hasUrl === true) {
      return { kind: "escalate" };
    }
    if (
      x.escalation.spendOverMicrosRequiresApproval !== undefined &&
      projectedMicros !== undefined &&
      projectedMicros > x.escalation.spendOverMicrosRequiresApproval
    ) {
      return { kind: "escalate" };
    }
  }

  return { kind: "pass" };
}
