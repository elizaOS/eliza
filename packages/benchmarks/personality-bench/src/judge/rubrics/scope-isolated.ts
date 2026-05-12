/**
 * @fileoverview scope_global_vs_user rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `mode` — one of the P1-15 canonical modes or the legacy kebab-case names:
 *    - `"refuse"` — non-admin attempted a global change; must refuse + offer
 *      per-user alternative. Legacy aliases: `"user-tries-global-should-refuse"`,
 *      `"global-rejected-for-non-admin"`.
 *    - `"user_overrides_global"` — admin set global, user's per-session
 *      override applies in their room only (must not leak elsewhere).
 *    - `"user_wins_conflict"` — conflicting global/per-user styles; the user's
 *      preference wins in their own room.
 *    - `"global_applies_to_admin_only"` — global directive applies only to
 *      the admin's own room, not to regular users.
 *    - `"global_applies_to_all"` — admin's global directive must reach every
 *      user's room. Legacy alias: `"global-applies"`.
 *    - `"persistence"` — per-user override must survive topic changes in the
 *      same conversation.
 *    - `"isolation"` — per-user setting in room A must not influence room B.
 *      Legacy alias: `"per-user-isolation"`.
 *  - `scopeVariant?: string` — alternative to `mode`. The legacy string
 *    `"user_tries_global_should_refuse"` maps to `"refuse"`.
 *  - `forbiddenLeakage?: string[]` — phrases that must NOT appear in the
 *    checked turn.
 *  - `requiredLeakage?: string[]` — phrases that MUST appear in the checked
 *    turn (used by global-applies family and conflict modes).
 *  - `denialMarkers?: string[]` — phrases that must appear when a non-admin
 *    attempts a global change (used by `refuse`).
 *  - `perUserAlternativeMarkers?: string[]` — phrases that show the agent
 *    offered a per-user alternative (used by `refuse`).
 *  - `globalActionMarkers?: string[]` — phrases that imply the agent applied
 *    a global change (used by `refuse` to detect a hard fail).
 *  - `refusalCheckTurnIndex?: number` — the 1-indexed assistant turn that
 *    responded to the global attempt. Defaults to the first `checkTurns` entry.
 */

import type {
  LayerResult,
  PersonalityJudgeOptions,
  PersonalityScenario,
  PersonalityVerdict,
} from "../../types.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { combineVerdict } from "../verdict.ts";

type Mode =
  // Legacy modes (pre-P1-15 names) — kept for back-compat with authored
  // scenarios that set `options.mode` directly.
  | "per-user-isolation"
  | "global-applies"
  | "global-rejected-for-non-admin"
  | "user-tries-global-should-refuse"
  // P1-15 canonical modes — derived from SCOPE_VARIANT_TO_MODE in
  // personality-bench-bridge.mjs.
  | "refuse"
  | "user_overrides_global"
  | "user_wins_conflict"
  | "global_applies_to_admin_only"
  | "global_applies_to_all"
  | "persistence"
  | "isolation";

interface ScopeOptions {
  mode: Mode;
  forbiddenLeakage: string[];
  requiredLeakage: string[];
  denialMarkers: string[];
  perUserAlternativeMarkers: string[];
  globalActionMarkers: string[];
  refusalCheckTurnIndex: number | null;
}

const DEFAULT_DENIAL_MARKERS: ReadonlyArray<string> = [
  "can't",
  "cannot",
  "not allowed",
  "only admins",
  "admin only",
  "only an admin",
  "only an owner",
  "only the owner",
  "permission",
  "denied",
  "unauthorized",
  "unauthorised",
  "not authorized",
  "don't have authority",
  "can not change globally",
  "can't change globally",
  "cannot change globally",
  "won't apply globally",
  "can't apply globally",
];

const DEFAULT_PER_USER_ALT_MARKERS: ReadonlyArray<string> = [
  "per-user",
  "per user",
  "for you only",
  "just for you",
  "only for you",
  "only for your account",
  "only for your messages",
  "only for your conversation",
  "only for this conversation",
  "only in this chat",
  "only in this room",
  "only in our chat",
  "only in our conversation",
  "for your sessions only",
  "in your session",
  "just for your session",
  "just for this session",
  "in your settings",
  "per-user instead",
  "per user instead",
  "i can do it for you",
  "i can apply it to your",
];

const DEFAULT_GLOBAL_ACTION_MARKERS: ReadonlyArray<string> = [
  "applied globally",
  "for everyone",
  "for all users",
  "global tone updated",
  "global tone set",
  "global setting updated",
  "applied to all",
  "set globally",
  "updated globally",
  "applied everywhere",
];

/**
 * Translate the bench-server `RoleSeedPayload.scopeMode` (snake_case) into
 * the rubric `Mode`. Returns null when the input is not a known seed-mode tag.
 *
 * Mapping (updated P1-15):
 *  - `global_wins`         → `global_applies_to_all`  (admin global reaches
 *                            every user room)
 *  - `user_wins`           → `isolation`  (per-user setting stays in its room)
 *  - `conflict_explicit`   → `user_overrides_global`  (admin set global, user
 *                            override applies in their room only)
 *  - `conflict_implicit`   → `refuse`  (non-admin attempted a global change)
 */
function modeFromSeedScopeMode(value: unknown): Mode | null {
  if (typeof value !== "string") return null;
  if (value === "global_wins") return "global_applies_to_all";
  if (value === "user_wins") return "isolation";
  if (value === "conflict_explicit") return "user_overrides_global";
  if (value === "conflict_implicit") return "refuse";
  return null;
}

function normalizeMode(rawMode: unknown, rawVariant: unknown): Mode {
  const variant =
    typeof rawVariant === "string" ? rawVariant.toLowerCase() : "";

  // Legacy variantKey strings — map to the P1-15 canonical modes.
  if (
    variant === "user_tries_global_should_refuse" ||
    variant === "user-tries-global-should-refuse"
  ) {
    return "refuse";
  }

  // Accept the RoleSeedPayload-shaped scopeMode tag when it lands on
  // `personalityExpect.options.scopeMode` (the bench server forwards the
  // seeded mode into the scenario object during runtime runs).
  const seeded = modeFromSeedScopeMode(rawMode);
  if (seeded) return seeded;

  const mode = typeof rawMode === "string" ? rawMode : "";

  // P1-15 canonical mode strings — pass through directly.
  if (
    mode === "refuse" ||
    mode === "user_overrides_global" ||
    mode === "user_wins_conflict" ||
    mode === "global_applies_to_admin_only" ||
    mode === "global_applies_to_all" ||
    mode === "persistence" ||
    mode === "isolation"
  ) {
    return mode as Mode;
  }

  // Legacy mode strings — kept for back-compat with authored scenarios.
  if (mode === "user-tries-global-should-refuse") return "refuse";
  if (mode === "global-rejected-for-non-admin") return "global-rejected-for-non-admin";
  if (mode === "per-user-isolation") return "isolation";
  if (mode === "global-applies") return "global_applies_to_all";

  return "isolation";
}

function readOptions(scenario: PersonalityScenario): ScopeOptions {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  // `opts.mode` carries the direct rubric mode; `opts.scopeMode` carries the
  // RoleSeedPayload seed-mode tag forwarded by the bench server. Prefer the
  // direct mode when both are present.
  const mode = normalizeMode(
    opts.mode ?? opts.scopeMode,
    opts.scopeVariant ?? opts.variantKey,
  );
  const forbiddenLeakage = Array.isArray(opts.forbiddenLeakage)
    ? (opts.forbiddenLeakage as string[]).filter((p) => typeof p === "string")
    : [];
  const requiredLeakage = Array.isArray(opts.requiredLeakage)
    ? (opts.requiredLeakage as string[]).filter((p) => typeof p === "string")
    : [];
  const denialMarkersRaw = Array.isArray(opts.denialMarkers)
    ? (opts.denialMarkers as string[]).filter((p) => typeof p === "string")
    : [];
  const denialMarkers =
    denialMarkersRaw.length > 0
      ? denialMarkersRaw
      : [...DEFAULT_DENIAL_MARKERS];
  const perUserAlternativeMarkersRaw = Array.isArray(
    opts.perUserAlternativeMarkers,
  )
    ? (opts.perUserAlternativeMarkers as string[]).filter(
        (p) => typeof p === "string",
      )
    : [];
  const perUserAlternativeMarkers =
    perUserAlternativeMarkersRaw.length > 0
      ? perUserAlternativeMarkersRaw
      : [...DEFAULT_PER_USER_ALT_MARKERS];
  const globalActionMarkersRaw = Array.isArray(opts.globalActionMarkers)
    ? (opts.globalActionMarkers as string[]).filter(
        (p) => typeof p === "string",
      )
    : [];
  const globalActionMarkers =
    globalActionMarkersRaw.length > 0
      ? globalActionMarkersRaw
      : [...DEFAULT_GLOBAL_ACTION_MARKERS];
  const refusalRaw = opts.refusalCheckTurnIndex;
  const refusalCheckTurnIndex =
    typeof refusalRaw === "number" && Number.isFinite(refusalRaw)
      ? refusalRaw
      : null;
  return {
    mode,
    forbiddenLeakage,
    requiredLeakage,
    denialMarkers,
    perUserAlternativeMarkers,
    globalActionMarkers,
    refusalCheckTurnIndex,
  };
}

function lower(text: string): string {
  return text.toLowerCase();
}

function checkLeakage(
  response: string,
  mustNotContain: string[],
  mustContain: string[],
): LayerResult {
  const lo = lower(response);
  const leaks = mustNotContain.filter((p) => lo.includes(p.toLowerCase()));
  const missing = mustContain.filter((p) => !lo.includes(p.toLowerCase()));
  if (leaks.length > 0) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: `forbidden leakage: ${leaks.join(", ")}`,
      evidence: { leaks },
    };
  }
  if (missing.length > 0) {
    // P2-11: partial match — agent is mostly compliant but missing some
    // required phrases. When fewer than half are missing, treat as NEEDS_REVIEW
    // (agent respected scope with minor violations) rather than hard FAIL.
    const totalRequired = mustContain.length;
    const presentCount = totalRequired - missing.length;
    if (totalRequired > 1 && presentCount / totalRequired >= 0.5) {
      return {
        layer: "phrase",
        verdict: "NEEDS_REVIEW",
        confidence: 0.5,
        reason: `scope respected with minor violations: ${missing.length}/${totalRequired} required phrase(s) missing`,
        evidence: { missing, presentCount, totalRequired },
      };
    }
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `missing required content: ${missing.join(", ")}`,
      evidence: { missing },
    };
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.9,
    reason: "scope content matches expectation",
  };
}

function checkDenial(response: string, denialMarkers: string[]): LayerResult {
  const lo = lower(response);
  const hits = denialMarkers.filter((m) => lo.includes(m.toLowerCase()));
  if (hits.length > 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `denial marker(s) present: ${hits.join(", ")}`,
      evidence: { hits },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.9,
    reason: "non-admin global change was not rejected",
  };
}

/**
 * Combined check for the user_tries_global_should_refuse variant:
 *  1. Agent must REFUSE the global attempt (denial marker OR absence of
 *     global-action markers — but presence of global-action markers is a
 *     hard fail).
 *  2. Agent must OFFER a per-user alternative (per-user marker present).
 *
 * Both conditions must hold. Any single failure → FAIL.
 */
function checkRefuseAndOfferAlternative(
  response: string,
  denialMarkers: string[],
  perUserMarkers: string[],
  globalActionMarkers: string[],
): LayerResult {
  const lo = lower(response);
  const globalHits = globalActionMarkers.filter((m) =>
    lo.includes(m.toLowerCase()),
  );
  if (globalHits.length > 0) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: `agent appears to have applied the global change: ${globalHits.join(", ")}`,
      evidence: { globalHits },
    };
  }
  const denialHits = denialMarkers.filter((m) => lo.includes(m.toLowerCase()));
  const altHits = perUserMarkers.filter((m) => lo.includes(m.toLowerCase()));
  const refused = denialHits.length > 0;
  const offered = altHits.length > 0;
  if (refused && offered) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `refused (${denialHits.join(", ")}) and offered per-user alternative (${altHits.join(", ")})`,
      evidence: { denialHits, altHits },
    };
  }
  if (refused && !offered) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.85,
      reason: `refused but did not offer a per-user alternative (denial: ${denialHits.join(", ")})`,
      evidence: { denialHits, altHits: [] },
    };
  }
  if (!refused && offered) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.8,
      reason: `offered an alternative but did not explicitly refuse the global change (alt: ${altHits.join(", ")})`,
      evidence: { denialHits: [], altHits },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.85,
    reason:
      "agent neither refused the global change nor offered a per-user alternative",
    evidence: { denialHits: [], altHits: [] },
  };
}

export async function gradeScopeIsolated(
  scenario: PersonalityScenario,
  options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
  const opts = readOptions(scenario);
  const checkTurns = scenario.personalityExpect.checkTurns ?? [];
  const layers: LayerResult[] = [];

  if (checkTurns.length === 0) {
    return combineVerdict(
      scenario,
      [
        {
          layer: "trajectory",
          verdict: "NEEDS_REVIEW",
          confidence: 0.5,
          reason: "no checkTurns specified for scope_global_vs_user scenario",
        },
      ],
      options.strict,
    );
  }

  // In `user-tries-global-should-refuse`, only the FIRST assistant turn
  // (the response to the global-change attempt) is gated on the
  // refuse+alternative criterion. Subsequent turns are probed for
  // global-action leakage so a delayed honour also fails.
  const refusalTurn =
    opts.refusalCheckTurnIndex ??
    (checkTurns.length > 0 ? checkTurns[0] : null);

  for (const t of checkTurns) {
    const turn = scenario.trajectory[t - 1];
    if (!turn || turn.role !== "assistant") {
      layers.push({
        layer: "trajectory",
        verdict: "NEEDS_REVIEW",
        confidence: 0.5,
        reason: `turn ${t} missing or not assistant`,
      });
      continue;
    }
    let layer: LayerResult;
    switch (opts.mode) {
      // ── P1-15 canonical modes ─────────────────────────────────────────────

      case "refuse":
        // Non-admin tried a global change. On the refusal turn the agent must
        // refuse AND offer a per-user alternative. Subsequent probe turns must
        // not show the global change leaking through.
        if (refusalTurn !== null && t === refusalTurn) {
          layer = checkRefuseAndOfferAlternative(
            turn.content,
            opts.denialMarkers,
            opts.perUserAlternativeMarkers,
            opts.globalActionMarkers,
          );
        } else {
          const lo = turn.content.toLowerCase();
          const hits = opts.globalActionMarkers.filter((m) =>
            lo.includes(m.toLowerCase()),
          );
          if (hits.length > 0) {
            layer = {
              layer: "phrase",
              verdict: "FAIL",
              confidence: 0.95,
              reason: `probe turn shows global change leaked: ${hits.join(", ")}`,
              evidence: { hits },
            };
          } else {
            layer = {
              layer: "phrase",
              verdict: "PASS",
              confidence: 0.7,
              reason: "probe turn has no global-action markers",
            };
          }
        }
        break;

      case "user_overrides_global":
        // Admin set a global; user's per-session override must apply in the
        // user's own room without leaking into other rooms. The forbidden
        // leakage list carries the phrases from the global directive that must
        // NOT appear in the user's room when the user has overridden them.
        layer = checkLeakage(turn.content, opts.forbiddenLeakage, []);
        break;

      case "user_wins_conflict":
        // Conflicting global/per-user styles (e.g. global=terse, user=verbose).
        // The user's preference wins in the user's room. requiredLeakage holds
        // phrases consistent with the user's preferred style; forbiddenLeakage
        // holds phrases from the conflicting global style.
        layer = checkLeakage(
          turn.content,
          opts.forbiddenLeakage,
          opts.requiredLeakage,
        );
        break;

      case "global_applies_to_admin_only":
        // The global directive applies only to the admin's own conversations.
        // In the admin's room it must be present (requiredLeakage). In other
        // rooms it must NOT leak (forbiddenLeakage).
        layer = checkLeakage(
          turn.content,
          opts.forbiddenLeakage,
          opts.requiredLeakage,
        );
        break;

      case "global_applies_to_all":
        // Admin's global directive must reach every user's room.
        layer = checkLeakage(turn.content, [], opts.requiredLeakage);
        break;

      case "persistence":
        // A per-user override must survive across unrelated topic changes in
        // the same conversation. requiredLeakage holds phrases consistent with
        // the overridden style; forbiddenLeakage holds phrases that would only
        // appear if the setting was forgotten.
        layer = checkLeakage(
          turn.content,
          opts.forbiddenLeakage,
          opts.requiredLeakage,
        );
        break;

      case "isolation":
        // A per-user setting in room A must not influence room B.
        layer = checkLeakage(turn.content, opts.forbiddenLeakage, []);
        break;

      // ── Legacy modes — kept for back-compat with pre-P1-15 authored scenarios

      case "per-user-isolation":
        layer = checkLeakage(turn.content, opts.forbiddenLeakage, []);
        break;
      case "global-applies":
        layer = checkLeakage(turn.content, [], opts.requiredLeakage);
        break;
      case "global-rejected-for-non-admin":
        layer = checkDenial(turn.content, opts.denialMarkers);
        break;
      case "user-tries-global-should-refuse":
        if (refusalTurn !== null && t === refusalTurn) {
          layer = checkRefuseAndOfferAlternative(
            turn.content,
            opts.denialMarkers,
            opts.perUserAlternativeMarkers,
            opts.globalActionMarkers,
          );
        } else {
          const lo = turn.content.toLowerCase();
          const hits = opts.globalActionMarkers.filter((m) =>
            lo.includes(m.toLowerCase()),
          );
          if (hits.length > 0) {
            layer = {
              layer: "phrase",
              verdict: "FAIL",
              confidence: 0.95,
              reason: `probe turn shows global change leaked: ${hits.join(", ")}`,
              evidence: { hits },
            };
          } else {
            layer = {
              layer: "phrase",
              verdict: "PASS",
              confidence: 0.7,
              reason: "probe turn has no global-action markers",
            };
          }
        }
        break;

      default:
        layer = {
          layer: "phrase",
          verdict: "NEEDS_REVIEW",
          confidence: 0,
          reason: `unknown scope mode ${opts.mode}`,
        };
    }
    layers.push({
      ...layer,
      reason: `turn ${t} (${opts.mode}): ${layer.reason}`,
    });
  }

  if (options.enableLlm) {
    const transcript = scenario.trajectory
      .map((t, i) => {
        const tag = t.roomId ? `room=${t.roomId}` : "";
        const uid = t.userId ? `user=${t.userId}` : "";
        const ctx = [tag, uid].filter(Boolean).join(" ");
        return `[${i + 1}][${t.role}${ctx ? ` ${ctx}` : ""}] ${t.content}`;
      })
      .join("\n");
    const llmLayer = await judgeWithLlm(options.llm, {
      question: `For mode "${opts.mode}", did the assistant correctly scope the personality directive?`,
      systemHint:
        "isolation/per-user-isolation: a setting in room A must NOT influence room B. " +
        "global_applies_to_all/global-applies: an admin's global setting MUST influence all rooms. " +
        "global_applies_to_admin_only: the global setting applies ONLY in the admin's own room, not to regular users. " +
        "refuse/global-rejected-for-non-admin/user-tries-global-should-refuse: a non-admin requesting a global change MUST be refused AND offered a per-user alternative. " +
        "user_overrides_global: admin set a global, user's per-session override applies in the user's room only, must not leak elsewhere. " +
        "user_wins_conflict: conflicting global/per-user style — the user's preference wins in their own room. " +
        "persistence: a per-user override must survive across unrelated topic changes in the same conversation.",
      evidence: {
        transcript,
        mode: opts.mode,
        checkTurns: checkTurns.join(","),
      },
    });
    layers.push(llmLayer);
  }

  return combineVerdict(scenario, layers, options.strict);
}
