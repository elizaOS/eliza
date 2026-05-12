/**
 * @fileoverview scope_global_vs_user rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `mode: "per-user-isolation" | "global-applies" | "global-rejected-for-non-admin" | "user-tries-global-should-refuse"`
 *  - `scopeVariant?: string` — alternative to `mode`. When set to
 *    `"user_tries_global_should_refuse"` (matching the W3-2 scenario tag),
 *    activates the refuse + per-user-alternative check.
 *  - `sourceRoomId?: string` and `targetRoomId?: string` — for cross-room checks.
 *  - `forbiddenLeakage?: string[]` — phrases from the source-room setting that
 *    must NOT appear in the target-room response.
 *  - `requiredLeakage?: string[]` — phrases that MUST appear (for global mode).
 *  - `denialMarkers?: string[]` — phrases that must appear when a non-admin
 *    attempts a global change. Used by both `global-rejected-for-non-admin`
 *    and `user-tries-global-should-refuse`.
 *  - `perUserAlternativeMarkers?: string[]` — phrases that show the agent
 *    offered a per-user alternative (only checked in
 *    `user-tries-global-should-refuse`).
 *  - `globalActionMarkers?: string[]` — phrases that imply the agent DID
 *    apply a global change (e.g. "applied globally", "for everyone") and that
 *    therefore mean refusal didn't happen. Only used in
 *    `user-tries-global-should-refuse`.
 *  - `refusalCheckTurnIndex?: number` — the 1-indexed assistant turn that
 *    responded to the global attempt. Defaults to the first `checkTurns`
 *    entry.
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
  | "per-user-isolation"
  | "global-applies"
  | "global-rejected-for-non-admin"
  | "user-tries-global-should-refuse";

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

function normalizeMode(rawMode: unknown, rawVariant: unknown): Mode {
  const variant =
    typeof rawVariant === "string" ? rawVariant.toLowerCase() : "";
  if (
    variant === "user_tries_global_should_refuse" ||
    variant === "user-tries-global-should-refuse"
  ) {
    return "user-tries-global-should-refuse";
  }
  const mode = typeof rawMode === "string" ? rawMode : "";
  if (mode === "user-tries-global-should-refuse") return mode;
  if (
    mode === "per-user-isolation" ||
    mode === "global-applies" ||
    mode === "global-rejected-for-non-admin"
  ) {
    return mode;
  }
  return "per-user-isolation";
}

function readOptions(scenario: PersonalityScenario): ScopeOptions {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  const mode = normalizeMode(opts.mode, opts.scopeVariant ?? opts.variantKey);
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
          // Probe turns after the refusal must not show the agent
          // applying the global change anyway (e.g. terse-everywhere
          // behaviour proves the global setting was honoured).
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
        "per-user-isolation: a setting in room A must NOT influence room B. global-applies: an admin's global setting MUST influence all rooms. global-rejected-for-non-admin: a non-admin requesting a global change MUST be refused. user-tries-global-should-refuse: a regular user attempting a GLOBAL change MUST be refused AND offered a per-user alternative.",
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
