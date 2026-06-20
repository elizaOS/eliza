import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UI-smoke spec-coverage ratchet gate (vitest, boot-free).
 *
 * Sibling to the action-coverage and route-coverage gates. Those gates prove
 * that every action/route is *enumerated* in the smoke matrix — but a spec that
 * is enumerated yet never executed in CI is false confidence. This gate closes
 * that hole on the spec axis: every Playwright spec under test/ui-smoke must be
 * accounted for as exactly one of
 *
 *   1. wired into the keyless CI workflow (scenario-pr.yml) — proven to run on
 *      every PR with no API keys, OR
 *   2. live-only — it genuinely cannot run keyless (needs a live agent runtime,
 *      a cloud sandbox, provider keys, or a running fixture endpoint), with the
 *      hard dependency named, OR
 *   3. tracked keyless debt — fixture-capable and *should* run keyless but is not
 *      yet wired. This bucket is a ratchet: it may only shrink.
 *   4. dedicated tool — deliberately excluded from default smoke because it is
 *      a long-running reporting/audit harness with its own package script.
 *
 * A new spec that is wired nowhere and classified nowhere fails test #1. Growing
 * the debt bucket past its recorded ceiling fails test #2. Wiring a debt spec
 * into the keyless workflow forces its removal from the debt list (test #2),
 * so coverage can only move forward.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_SMOKE_DIR = path.join(HERE, "ui-smoke");
const REPO_ROOT = path.resolve(HERE, "../../..");
const KEYLESS_WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/scenario-pr.yml",
);

/**
 * Specs that legitimately cannot run in keyless CI. Each entry names the hard
 * dependency that blocks keyless execution. Verified against the spec source:
 * an entry here must guard itself behind that dependency (env flag, baseURL,
 * cloud sandbox, or running endpoint), not merely be unwired.
 */
const LIVE_ONLY: Readonly<Record<string, string>> = {
  "cloud-live.spec.ts":
    "real cloud login + provisioning + chat against real Eliza Cloud; needs " +
    "ELIZA_UI_SMOKE_CLOUD_LIVE=1 + ELIZA_UI_SMOKE_LIVE_STACK=1 + " +
    "ELIZAOS_CLOUD_API_KEY and spends real cloud credits, so it never runs in a " +
    "keyless PR lane — wired only into the nightly app-live-e2e.yml workflow.",
  "multi-client-desync.spec.ts":
    "needs a live shared messaging backend so two independent browser contexts " +
    "(separate localStorage/page.route mocks) converge on one server-side " +
    "channel; the keyless helper route layer echoes a fresh per-request fixture " +
    "with no shared store, so the spec is skipped until a shared agent + " +
    "channel stack (ELIZA_UI_SMOKE_LIVE_STACK=1) is available.",
  "multi-window-sync.spec.ts":
    "needs the cross-window sync layer (packages/ui/src/state/useTabSync.ts + " +
    "BroadcastChannel) which does not exist in the renderer yet; the spec is " +
    "skipped against the desired theme-toggle broadcast behavior and only " +
    "activates once that feature ships.",
  "vault-routing.spec.ts":
    "deep routing-config write→reload→read-back needs the real on-disk vault " +
    "(ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless stub's GET /api/secrets/routing " +
    "is a static {rules:[]} and its PUT does not persist, so a saved rule never " +
    "reloads. Guarded by test.skip(!LIVE_STACK).",
  "wallet-keys.spec.ts":
    "deep wallet-key add→reveal→delete round-trip needs the real on-disk vault " +
    "(ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless stub returns a fixed wallet " +
    "inventory and does not persist PUT/DELETE on /api/secrets/inventory/:key. " +
    "Guarded by test.skip(!LIVE_STACK).",
  "provider-config.spec.ts":
    "real provider switch needs the app-core runtime to service POST " +
    "/api/provider/switch and re-derive the active provider " +
    "(ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless stub neither restarts the agent " +
    "nor reflects the switched provider. Guarded by test.skip(!LIVE_STACK).",
  "view-switching-local-llm-e2e.spec.ts":
    "drives real chat through a local llama.cpp model planner and requires a " +
    "running llama-server (LLAMACPP_URL, usually with an eliza-1 GGUF loaded); " +
    "the keyless PR lane cannot provide that model daemon or GPU/CPU budget, so " +
    "it is a manual/live local-model report spec rather than a secret-free PR gate.",
};

/**
 * Specs that are intentionally not default smoke tests. They are still runnable,
 * but only through a named package script because they emit manual-review
 * artifacts or run a broad reporting walk instead of a narrow PR assertion.
 */
const DEDICATED_TOOL: Readonly<Record<string, string>> = {
  "all-views-aesthetic-audit.spec.ts":
    "runs via `bun run --cwd packages/app audit:app`; it walks every app view " +
    "at desktop and mobile, captures artifacts, and writes manual-review " +
    "stubs, so it is a deliberate visual-audit tool rather than default smoke.",
};

/**
 * Fixture-capable specs that SHOULD run in keyless CI but are not yet wired into
 * scenario-pr.yml. RATCHET: this list may only shrink. To wire one, add a
 * Playwright step for it in scenario-pr.yml, delete it here, and decrement
 * MAX_KEYLESS_DEBT. Never add a new spec here without also lowering the ceiling
 * back down as you pay debt off elsewhere — the ceiling is the forcing function.
 */
const KEYLESS_DEBT: Readonly<Record<string, string>> = {
  "apps-personal-assistant-feed-interactions.spec.ts":
    "Fixture-driven personal-assistant feed smoke; needs keyless wiring after " +
    "the lifeops decomposition refactor settles the new view-bearing plugins.",
  "sensitive-request-in-chat.spec.ts":
    "Fixture-driven sensitive-request chat smoke; needs keyless wiring after " +
    "the lifeops decomposition refactor settles the new view-bearing plugins.",
  "task-widget-in-chat.spec.ts":
    "Fixture-driven task-widget chat smoke; needs keyless wiring after " +
    "the lifeops decomposition refactor settles the new view-bearing plugins.",
};

/**
 * Hard ceiling on the keyless-debt bucket. Decrement every time a spec is wired
 * into keyless CI. This is the ratchet that prevents new dark specs from being
 * parked in debt indefinitely.
 */
const MAX_KEYLESS_DEBT = 3;

function specFileNames(): string[] {
  return readdirSync(UI_SMOKE_DIR)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();
}

function keylessWiredSpecs(): Set<string> {
  const workflow = readFileSync(KEYLESS_WORKFLOW, "utf8");
  return new Set(
    [...workflow.matchAll(/test\/ui-smoke\/([a-z0-9-]+\.spec\.ts)/g)].map(
      (match) => match[1] ?? "",
    ),
  );
}

describe("ui-smoke spec coverage gate", () => {
  it("every ui-smoke spec is wired keyless, live-only, tracked debt, or a dedicated tool", () => {
    const wired = keylessWiredSpecs();
    const unclassified = specFileNames().filter(
      (name) =>
        !wired.has(name) &&
        !(name in LIVE_ONLY) &&
        !(name in KEYLESS_DEBT) &&
        !(name in DEDICATED_TOOL),
    );

    expect(
      unclassified,
      `Unclassified ui-smoke specs (wire into .github/workflows/scenario-pr.yml, ` +
        `or record in LIVE_ONLY with its hard dependency, in KEYLESS_DEBT, ` +
        `or in DEDICATED_TOOL): ` +
        `${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("keyless-debt bucket is a non-growing ratchet of real, unwired specs", () => {
    const wired = keylessWiredSpecs();
    const specs = new Set(specFileNames());
    const debt = Object.keys(KEYLESS_DEBT);

    expect(
      debt.length,
      `KEYLESS_DEBT (${debt.length}) exceeds its ceiling (${MAX_KEYLESS_DEBT}). ` +
        `Do not park new dark specs in debt — wire them into keyless CI instead.`,
    ).toBeLessThanOrEqual(MAX_KEYLESS_DEBT);

    const stale = debt.filter((name) => !specs.has(name));
    expect(
      stale,
      `KEYLESS_DEBT references specs that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);

    const alreadyWired = debt.filter((name) => wired.has(name));
    expect(
      alreadyWired,
      `These specs are wired into keyless CI but still listed as debt — ` +
        `remove them from KEYLESS_DEBT and decrement MAX_KEYLESS_DEBT: ` +
        `${alreadyWired.join(", ")}`,
    ).toEqual([]);
  });

  it("live-only entries are real specs and excluded from the keyless gate", () => {
    const wired = keylessWiredSpecs();
    const specs = new Set(specFileNames());
    const liveOnly = Object.keys(LIVE_ONLY);

    const stale = liveOnly.filter((name) => !specs.has(name));
    expect(
      stale,
      `LIVE_ONLY references specs that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);

    const wiredLive = liveOnly.filter((name) => wired.has(name));
    expect(
      wiredLive,
      `LIVE_ONLY specs must not be in the keyless workflow (they need a live ` +
        `stack): ${wiredLive.join(", ")}`,
    ).toEqual([]);

    const everyLiveOnlyHasReason = liveOnly.every(
      (name) => LIVE_ONLY[name]?.trim().length,
    );
    expect(
      everyLiveOnlyHasReason,
      "Every LIVE_ONLY entry must name its hard dependency",
    ).toBe(true);
  });

  it("dedicated tool entries are real specs and excluded from the keyless gate", () => {
    const wired = keylessWiredSpecs();
    const specs = new Set(specFileNames());
    const dedicated = Object.keys(DEDICATED_TOOL);

    const stale = dedicated.filter((name) => !specs.has(name));
    expect(
      stale,
      `DEDICATED_TOOL references specs that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);

    const wiredDedicated = dedicated.filter((name) => wired.has(name));
    expect(
      wiredDedicated,
      `DEDICATED_TOOL specs must not be in the keyless workflow (they run via ` +
        `their own package script): ${wiredDedicated.join(", ")}`,
    ).toEqual([]);

    const everyDedicatedHasReason = dedicated.every(
      (name) => DEDICATED_TOOL[name]?.trim().length,
    );
    expect(
      everyDedicatedHasReason,
      "Every DEDICATED_TOOL entry must name its package-script path",
    ).toBe(true);
  });

  it("no spec is classified in more than one bucket", () => {
    const classified = new Map<string, string[]>();
    for (const [bucketName, bucket] of Object.entries({
      LIVE_ONLY,
      KEYLESS_DEBT,
      DEDICATED_TOOL,
    })) {
      for (const name of Object.keys(bucket)) {
        classified.set(name, [...(classified.get(name) ?? []), bucketName]);
      }
    }
    const inBoth = [...classified.entries()]
      .filter(([, buckets]) => buckets.length > 1)
      .map(([name, buckets]) => `${name} (${buckets.join(", ")})`);
    expect(
      inBoth,
      `Specs in more than one classification bucket: ${inBoth.join(", ")}`,
    ).toEqual([]);
  });

  it("every keyless-wired spec name resolves to a real spec file", () => {
    const specs = new Set(specFileNames());
    const missing = [...keylessWiredSpecs()].filter((name) => !specs.has(name));
    expect(
      missing,
      `scenario-pr.yml references ui-smoke specs that do not exist ` +
        `(rename/typo?): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
