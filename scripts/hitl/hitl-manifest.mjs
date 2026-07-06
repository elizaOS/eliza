/**
 * HITL manifest (#14381).
 *
 * Maps human-decision points to the EXISTING e2e recording suites
 * (`scripts/e2e-recordings/suites.mjs`) that stage the frames a human must
 * eyeball. This is the tag layer the runner uses to select the onboarding /
 * first-chat / login subset and to know which decision points are only
 * satisfiable on a real device (routed to the Seeker pass, not faked headless).
 *
 * Marks:
 *   frame  — headless can stage + screenshot the state; human judges the frame
 *   device — needs a real device capability; NOT covered headless
 *   auto   — machine-decidable; listed for completeness, no human needed
 *
 * See docs/testing/hitl-inventory.md for the full rationale per row.
 */

/** @typedef {"frame"|"device"|"auto"} HitlMark */

/**
 * @typedef {Object} HitlDecisionPoint
 * @property {string} id           stable id for the decision point
 * @property {string} group        onboarding | first-chat | login | wallet | notifications | visual | lifeops-live
 * @property {string} label        human-readable
 * @property {HitlMark} mark
 * @property {string} why          why a human/device is required
 * @property {string[]} suites     UI_E2E_SUITES names that stage this (empty if device-only)
 * @property {string[]} [scripts]  specific package test scripts that stage frames
 * @property {number[]} [issues]   related GitHub issues
 */

/** @type {HitlDecisionPoint[]} */
export const HITL_DECISION_POINTS = [
  // ── Onboarding ──────────────────────────────────────────────────────────
  {
    id: "onboarding-welcome",
    group: "onboarding",
    label: "First-run welcome + name/style pick",
    mark: "frame",
    why: "first impression, copy, pacing — not machine-decidable",
    suites: ["app", "android-emu", "ios-sim"],
    scripts: ["test:ftu-home-e2e"],
    issues: [14382, 14168],
  },
  {
    id: "onboarding-provider",
    group: "onboarding",
    label: "Provider / model selection grid",
    mark: "frame",
    why: "catalog correctness + visual density",
    suites: ["app"],
    issues: [14382],
  },
  {
    id: "onboarding-replay",
    group: "onboarding",
    label: "Re-run onboarding on a real agent (no wipe)",
    mark: "frame",
    why: "historically impossible without nuking memories — see the dev-gated replay entry",
    suites: ["app"],
    issues: [14382],
  },
  {
    id: "onboarding-persist",
    group: "onboarding",
    label: "Onboarding persists across restart",
    mark: "auto",
    why: "machine-decided by first-run-persistence.restart.test.ts",
    suites: [],
    issues: [14382],
  },

  // ── First chat ──────────────────────────────────────────────────────────
  {
    id: "first-chat-send",
    group: "first-chat",
    label: "First message send → streamed reply",
    mark: "frame",
    why: "cadence/feel; real inference needs credits (stubbed frames here)",
    suites: ["app"],
    issues: [14424],
  },
  {
    id: "first-chat-suggestions",
    group: "first-chat",
    label: "Suggestions / FTU home widgets",
    mark: "frame",
    why: "visual + relevance",
    suites: ["app"],
    scripts: ["test:suggestions-e2e", "test:ftu-home-e2e"],
  },
  {
    id: "first-chat-scroll",
    group: "first-chat",
    label: "Chat scroll / momentum / sheet detents",
    mark: "frame",
    why: "gesture feel",
    suites: ["app"],
    scripts: [
      "test:chat-scroll-web-e2e",
      "test:chat-sheet-e2e",
      "test:chatux-gesture-e2e",
    ],
    issues: [14380],
  },

  // ── Login / auth ────────────────────────────────────────────────────────
  {
    id: "login-cloud-mock",
    group: "login",
    label: "Cloud sign-in (mock OAuth round-trip)",
    mark: "frame",
    why: "mockable frames only; REAL sign-in is device-only per FLEET.md",
    suites: ["cloud-e2e"],
    issues: [13609],
  },
  {
    id: "login-real-device",
    group: "login",
    label: "Real cloud sign-in golden path",
    mark: "device",
    why: "real OAuth/token/tenant — injected state is banned as evidence",
    suites: [],
    issues: [13611, 13610, 13609],
  },
  {
    id: "login-stale-token-spam",
    group: "login",
    label: "Stale-token / no-credits resume spam guard",
    mark: "auto",
    why: "machine-decided by use-first-run-conductor.test.ts (#14387)",
    suites: [],
    issues: [14387],
  },

  // ── Wallet / notifications (mostly device) ──────────────────────────────
  {
    id: "wallet-empty-render",
    group: "wallet",
    label: "Wallet view render (no leaked 'Not found')",
    mark: "frame",
    why: "error-string leak visible only to the eye (#14426)",
    suites: ["app"],
    issues: [14426],
  },
  {
    id: "notifications-priming",
    group: "notifications",
    label: "Permission priming prompt",
    mark: "frame",
    why: "copy + timing",
    suites: ["app"],
    scripts: ["test:permission-priming-e2e"],
  },

  // ── LifeOps live validation (#11632) ────────────────────────────────────
  // The operator lane for the live, account/device-backed LifeOps pass.
  // Deliberately OUTSIDE HITL_GOLDEN_GROUPS: it needs real credentials and
  // devices, so it is selected explicitly via --groups=lifeops-live.
  {
    id: "lifeops-cred-intake",
    group: "lifeops-live",
    label: "Connector credential intake / readiness dashboard",
    mark: "frame",
    why: "a human confirms which connector creds are present in .env before the live lanes run",
    suites: [],
    scripts: ["scripts/lifeops/hitl-credential-dashboard.mjs"],
    issues: [11632],
  },
  {
    id: "lifeops-matrix-credentialed",
    group: "lifeops-live",
    label: "9-state OWNER/AGENT permission matrix (credentialed)",
    mark: "auto",
    why: "machine-decided by owner-agent-permission-matrix.integration.test.ts under LIFEOPS_PERMISSION_MATRIX=1",
    suites: [],
    issues: [11632],
  },
  {
    id: "lifeops-live-connector-suites",
    group: "lifeops-live",
    label: "Live connector suites (creds present → live; absent → clean skip)",
    mark: "auto",
    why: "machine-decided; each suite describeIf-gates on its own credentials",
    suites: [],
    scripts: ["scripts/lifeops/run-11632-live-lanes.mjs"],
    issues: [11632],
  },
  {
    id: "lifeops-populated-views",
    group: "lifeops-live",
    label: "LifeOps split views populated with live account data",
    mark: "frame",
    why: "populated/empty/error render quality with real data is judged by eye",
    suites: ["app"],
    issues: [11632],
  },
  {
    id: "lifeops-ios-native",
    group: "lifeops-live",
    label: "iOS/macOS native flows (HealthKit, Family Controls, SelfControl)",
    mark: "device",
    why: "real OS permission dialogs + native capabilities — not fakeable headless",
    suites: [],
    issues: [11632],
  },
  {
    id: "lifeops-android-native",
    group: "lifeops-live",
    label:
      "Android native flows (Health Connect, SMS default-role, Usage Access)",
    mark: "device",
    why: "real OS permission dialogs + SIM-backed capabilities — not fakeable headless",
    suites: [],
    issues: [11632],
  },
];

/** The core golden-path groups this session's harness targets. */
export const HITL_GOLDEN_GROUPS = ["onboarding", "first-chat", "login"];

/** All e2e suite names referenced by frame-mark decision points (dedup). */
export function hitlFrameSuites(groups = HITL_GOLDEN_GROUPS) {
  const names = new Set();
  for (const dp of HITL_DECISION_POINTS) {
    if (dp.mark !== "frame") continue;
    if (groups && !groups.includes(dp.group)) continue;
    for (const s of dp.suites) names.add(s);
  }
  return [...names];
}

/** Decision points that are device-only (routed to the Seeker pass, not faked). */
export function hitlDeviceOnly(groups = HITL_GOLDEN_GROUPS) {
  return HITL_DECISION_POINTS.filter(
    (dp) => dp.mark === "device" && (!groups || groups.includes(dp.group)),
  );
}
