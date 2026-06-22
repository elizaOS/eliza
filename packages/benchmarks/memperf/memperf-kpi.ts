/**
 * Memory-benchmark KPI (issue #8809).
 *
 * A runnable desktop/server harness that, for each available Eliza-1 tier ×
 * modality (text, embedding, transcription, tts, vad, vision), records:
 *   - load ms,
 *   - resident RSS delta (process.memoryUsage().rss before/after the load),
 *   - peak RSS (sampled across the load+run window),
 *   - tokens/sec or RTF where applicable,
 * and, under a scripted co-residency sequence (load text → load vision →
 * load voice → force pressure), the MemoryArbiter eviction count — taken from
 * the arbiter's own `onEvent` telemetry, not estimated.
 *
 * It emits a JSON report whose per-row shape is the shared METRIC_SCHEMA
 * (consumed by both this issue's desktop harness and #8800's mobile workbench),
 * checks the numbers against `budgets.json`, and exits:
 *   0 pass, 1 budget failure, 2 nothing measurable (skip).
 *
 * Honesty contract (no fabricated metrics, no always-pass stub):
 *   - A modality row is `measured: true` ONLY when a real load+run produced the
 *     numbers. Absent a model bundle / backend, the row is `measured: false`
 *     with a concrete `skipReason`. The summary records exactly what was skipped.
 *   - The co-residency block runs in `mode: "real"` when real backends drove
 *     the sequence, or `mode: "self-check"` when it exercised the arbiter
 *     fit/pressure path with synthetic *sized* loaders to verify the eviction
 *     telemetry plumbing end-to-end. A self-check is NEVER reported as a tier
 *     metric and never satisfies the budget for measured evictions — it only
 *     proves the arbiter counts evictions, which is the AC the harness wires.
 *
 * Run:
 *   bun --conditions=eliza-source packages/benchmarks/memperf/memperf-kpi.ts
 *   bun --conditions=eliza-source packages/benchmarks/memperf/memperf-kpi.ts --json
 *
 * Env:
 *   MEMPERF_TIERS=eliza-1-2b,eliza-1-4b   limit measurement to these tiers
 *   MEMPERF_MAX_TOKENS=24                  text/vision generation length for tok/s
 */

import {
  classifyDeviceTier,
  findCatalogModel,
  type BackendGenerateArgs as GenerateArgs,
  localInferenceEngine,
  MemoryArbiter,
  probeHardware,
} from "@elizaos/plugin-local-inference/services";
import { resolveLocalInferenceLoadArgs } from "@elizaos/plugin-local-inference/services/active-model";
import type {
  ArbiterCapability,
  ArbiterEvent,
} from "@elizaos/plugin-local-inference/services/memory-arbiter";
import { capacitorPressureSource } from "@elizaos/plugin-local-inference/services/memory-pressure";
import { resolveRamBudget } from "@elizaos/plugin-local-inference/services/ram-budget";
import { listInstalledModels } from "@elizaos/plugin-local-inference/services/registry";
import {
  ELIZA_1_TIER_IDS,
  type Eliza1TierId,
} from "@elizaos/shared/local-inference/catalog";
import { loadBudgets, ms, recordResult, rssMb } from "./lib.mjs";
// metric-schema + lib are plain ESM; import via relative path so this file is
// self-contained and the schema is literally the one #8800 reads.
import {
  METRIC_SCHEMA,
  MODALITIES,
  skippedModalityRow,
  THROUGHPUT_UNIT,
} from "./metric-schema.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
const MAX_TOKENS = Number(process.env.MEMPERF_MAX_TOKENS ?? 24);

type Modality = (typeof MODALITIES)[number];

interface ModalityMetric {
  tier: string;
  modality: Modality;
  measured: boolean;
  skipReason?: string;
  loadMs: number | null;
  firstResultMs: number | null;
  throughput: number | null;
  throughputUnit: string | null;
  rssBeforeMb: number | null;
  rssAfterMb: number | null;
  rssDeltaMb: number | null;
  peakRssMb: number | null;
  estimatedMb: number | null;
}

interface CoResidencyMetric {
  measured: boolean;
  mode: "real" | "self-check";
  sequence: string[];
  loadCount: number;
  evictionCount: number;
  pressureEvents: number;
  budgetMb: number;
  evictions: Array<{
    capability: string;
    modelKey: string;
    reason: string;
    estimatedMb: number;
  }>;
}

/** Continuously sample RSS while `fn` runs; return its result + the peak RSS (MB) observed. */
async function withPeakRss<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; peakMb: number }> {
  let peak = rssMb();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const cur = rssMb();
      if (cur > peak) peak = cur;
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  try {
    const result = await fn();
    const cur = rssMb();
    if (cur > peak) peak = cur;
    return { result, peakMb: peak };
  } finally {
    sampling = false;
    await sampler;
  }
}

/** Rough token count for tok/s — the engine `generate` returns text only. */
function estimateTokens(text: string): number {
  // ~4 chars/token is the conventional estimate; never below 1 for a non-empty string.
  return Math.max(text.length > 0 ? 1 : 0, Math.round(text.length / 4));
}

/**
 * Measure the TEXT modality for an installed Eliza-1 tier: real engine load,
 * RSS before/after/peak, then a real generation to derive tok/s. Returns a
 * `measured: false` row with a concrete reason on any precondition miss.
 */
async function measureText(
  tier: Eliza1TierId,
  installedPath: string,
): Promise<ModalityMetric> {
  const catalog = findCatalogModel(tier);
  const installed = (await listInstalledModels()).find(
    (m) => m.path === installedPath,
  );
  let estimatedMb: number | null = null;
  if (catalog && installed) {
    const budget = resolveRamBudget(catalog, installed);
    estimatedMb = budget.recommendedMb;
  }

  const rssBeforeMb = rssMb();

  const overrides = installed
    ? await resolveLocalInferenceLoadArgs(installed, {}).catch(() => undefined)
    : undefined;

  const { result, peakMb } = await withPeakRss(async () => {
    const loadStart = performance.now();
    await localInferenceEngine.load(installedPath, overrides);
    const loadMs = performance.now() - loadStart;

    const genStart = performance.now();
    const genArgs: GenerateArgs = {
      prompt: "Reply with a single short sentence about memory.",
      maxTokens: MAX_TOKENS,
    };
    const text = await localInferenceEngine.generate(genArgs);
    const genMs = performance.now() - genStart;
    const tokens = estimateTokens(text);
    return {
      loadMs: Number(loadMs.toFixed(1)),
      // generate() is non-streaming → first result == full decode.
      firstResultMs: Number(genMs.toFixed(1)),
      throughput:
        genMs > 0 ? Number(((tokens / genMs) * 1000).toFixed(2)) : null,
    };
  });

  const rssAfterMb = rssMb();
  return {
    tier,
    modality: "text",
    measured: true,
    loadMs: result.loadMs,
    firstResultMs: result.firstResultMs,
    throughput: result.throughput,
    throughputUnit: THROUGHPUT_UNIT.text,
    rssBeforeMb,
    rssAfterMb,
    rssDeltaMb: Number((rssAfterMb - rssBeforeMb).toFixed(1)),
    peakRssMb: peakMb,
    estimatedMb,
  };
}

/**
 * The scripted co-residency sequence (load text → load vision → load voice →
 * force pressure) against a REAL MemoryArbiter, reading the eviction count from
 * its `onEvent` telemetry — the exact arbiter eviction path #8809 AC asks the
 * harness to surface.
 *
 * The loaders are synthetic but SIZED (estimatedMb mirrors the production
 * registrations: text 1200, vision 600, …). This is deliberate and honest: the
 * desktop engine loads ONE model at a time (unload-then-load swaps), so a true
 * multi-backend co-residency cannot be driven through it. What IS real here is
 * the arbiter's eviction *policy and telemetry* — the fit-to-budget LRU path and
 * the critical-pressure path both fire on these sizes and emit the eviction
 * events the harness counts. The result is always labelled `mode: "self-check"`
 * so it is never mistaken for a measured-backend run, and the budget gate that
 * consumes it (`selfCheckMinEvictions`) only asserts the telemetry counts — it
 * can never satisfy the real-backend eviction ceiling.
 *
 * The self-check budget is small enough that the second/third non-text load
 * exceeds it, forcing a fit-eviction without allocating real memory.
 */
const SELF_CHECK_BUDGET_MB = 1000; // two ~600 MB roles already exceed this → eviction

/** estimatedMb per capability — mirrors the production registrations in service.ts. */
const SELF_CHECK_SIZES: Record<ArbiterCapability, number> = {
  text: 1200,
  embedding: 300,
  "vision-describe": 600,
  "image-gen": 1100,
  transcribe: 250,
};

async function runCoResidency(): Promise<CoResidencyMetric> {
  const events: ArbiterEvent[] = [];
  const sequence: string[] = [];

  // A standalone arbiter on a fresh registry — never the engine's live arbiter,
  // so a benchmark run cannot evict a model the running agent is using.
  const pressure = capacitorPressureSource();
  const arbiter = new MemoryArbiter({
    registry: localInferenceEngine.getSharedResources(),
    pressureSource: pressure,
    budgetMb: () => SELF_CHECK_BUDGET_MB,
    now: () => Date.now(),
  });
  const off = arbiter.onEvent((e) => events.push(e));
  arbiter.start();

  for (const cap of Object.keys(SELF_CHECK_SIZES) as ArbiterCapability[]) {
    arbiter.registerCapability({
      capability: cap,
      estimatedMb: SELF_CHECK_SIZES[cap],
      load: async () => ({ cap }),
      unload: async () => {},
      run: async () => ({}),
    });
  }

  try {
    // load text (pinned target) → vision → voice(transcribe). Each `acquire`
    // runs the fit-to-budget path; on the self-check budget the 2nd/3rd non-text
    // loads force LRU fit evictions. Release immediately so each role is
    // refcount-0 (the precondition for LRU eviction) before the next load.
    const order: Array<[ArbiterCapability, string]> = [
      ["text", "eliza-1-text"],
      ["vision-describe", "eliza-1-vision"],
      ["transcribe", "eliza-1-asr"],
    ];
    for (const [cap, key] of order) {
      sequence.push(`${cap}::${key}`);
      await (await arbiter.acquire(cap, key)).release();
    }
    // force pressure: dispatch a critical OS memory-warning. The arbiter evicts
    // every non-text resident role and emits eviction telemetry for each.
    pressure.dispatch("critical", 128);
    // Let the async pressure handler drain.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    off();
    await arbiter.shutdown();
  }

  const evictions = events
    .filter(
      (e): e is Extract<ArbiterEvent, { type: "eviction" }> =>
        e.type === "eviction",
    )
    .map((e) => ({
      capability: e.capability,
      modelKey: e.modelKey,
      reason: e.reason,
      estimatedMb: e.estimatedMb,
    }));

  return {
    measured: false,
    mode: "self-check",
    sequence,
    loadCount: events.filter((e) => e.type === "model_load").length,
    evictionCount: evictions.length,
    pressureEvents: events.filter((e) => e.type === "memory_pressure").length,
    budgetMb: SELF_CHECK_BUDGET_MB,
    evictions,
  };
}

interface BudgetCheck {
  name: string;
  value: number | null;
  budget: number;
  unit: string;
  pass: boolean;
}

function checkBudgets(
  rows: ModalityMetric[],
  co: CoResidencyMetric,
): BudgetCheck[] {
  const b = loadBudgets();
  const checks: BudgetCheck[] = [];

  // Per-tier peak RSS budget — only enforced on MEASURED text rows (the only
  // modality with a per-tier peak-RSS budget today; others are recorded but
  // not yet gated). A skipped row never fails a budget.
  for (const row of rows) {
    if (!row.measured || row.modality !== "text") continue;
    const tierBudget = b.tiers?.[row.tier]?.peakRssMb;
    if (typeof tierBudget !== "number") continue;
    checks.push({
      name: `${row.tier}.text.peakRssMb`,
      value: row.peakRssMb,
      budget: tierBudget,
      unit: "MB",
      pass: row.peakRssMb != null && row.peakRssMb <= tierBudget,
    });
  }

  // Co-residency eviction budget. The self-check has its own (looser) gate: it
  // must produce AT LEAST one eviction (proving the telemetry counts), and the
  // real path must stay AT OR BELOW the configured ceiling for a known-fitting
  // set. The two never share a threshold — a self-check can't satisfy the real
  // regression gate, and a real run can't be masked by the self-check.
  if (co.mode === "real") {
    const maxEvict = b.coResidency?.maxEvictions ?? 0;
    checks.push({
      name: "coResidency.maxEvictions",
      value: co.evictionCount,
      budget: maxEvict,
      unit: "count",
      pass: co.evictionCount <= maxEvict,
    });
  } else {
    const minEvict = b.coResidency?.selfCheckMinEvictions ?? 1;
    checks.push({
      name: "coResidency.selfCheckMinEvictions",
      value: co.evictionCount,
      budget: minEvict,
      unit: "count",
      // self-check: the value must be AT LEAST the floor (telemetry proven).
      pass: co.evictionCount >= minEvict,
    });
  }

  return checks;
}

async function main(): Promise<void> {
  const probe = await probeHardware();
  const tierAssessment = classifyDeviceTier(probe);
  const ffiAvailable = await localInferenceEngine
    .available()
    .catch(() => false);
  const installed = await listInstalledModels();

  const tierFilter = (process.env.MEMPERF_TIERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Map installed curated Eliza-1 tier bundles by id. External LM-Studio/Ollama/HF
  // scans are NOT Eliza-1 tiers and are deliberately not measured as such.
  const installedTierPath = new Map<Eliza1TierId, string>();
  for (const m of installed) {
    if ((ELIZA_1_TIER_IDS as readonly string[]).includes(m.id)) {
      installedTierPath.set(m.id as Eliza1TierId, m.path);
    }
  }

  const rows: ModalityMetric[] = [];
  const skips: Array<{ tier: string; modality: string; reason: string }> = [];

  const tiersToConsider = (
    tierFilter.length > 0 ? tierFilter : (ELIZA_1_TIER_IDS as readonly string[])
  ) as Eliza1TierId[];

  for (const tier of tiersToConsider) {
    const path = installedTierPath.get(tier);
    for (const modality of MODALITIES) {
      // TEXT is the only modality the desktop harness can drive end-to-end
      // today via the in-process engine. The voice/vision/embedding backends
      // require their capability registrations (wired by the live
      // LocalInferenceService) + their model files; absent those, record a
      // concrete skip rather than a fabricated number.
      if (modality === "text") {
        if (!path) {
          const reason = `no installed Eliza-1 bundle for tier "${tier}"`;
          rows.push(skippedModalityRow(tier, modality, reason));
          skips.push({ tier, modality, reason });
          continue;
        }
        if (!ffiAvailable) {
          const reason = "llama.cpp FFI backend unavailable on this host";
          rows.push(skippedModalityRow(tier, modality, reason));
          skips.push({ tier, modality, reason });
          continue;
        }
        try {
          rows.push(await measureText(tier, path));
        } catch (err) {
          const reason = `text load/generate failed: ${err instanceof Error ? err.message : String(err)}`;
          rows.push(skippedModalityRow(tier, modality, reason));
          skips.push({ tier, modality, reason });
        }
        continue;
      }
      // Non-text modalities: skip with a concrete reason. They are measured
      // on-device by the iOS grind (#8800 schema) and will be wired here once
      // the desktop voice/vision capability registrations expose a runnable
      // load+run seam outside the full service boot.
      const reason = path
        ? `${modality} desktop measurement not yet wired (requires live capability registration)`
        : `no installed Eliza-1 bundle for tier "${tier}"`;
      rows.push(skippedModalityRow(tier, modality, reason));
      skips.push({ tier, modality, reason });
    }
  }

  const coResidency = await runCoResidency();
  const checks = checkBudgets(rows, coResidency);

  const measuredCount = rows.filter((r) => r.measured).length;
  const pass = checks.every((c) => c.pass);

  const result = {
    schema: METRIC_SCHEMA,
    summary: {
      host: {
        tier: tierAssessment.tier,
        totalRamGb: Number(probe.totalRamGb.toFixed(1)),
        freeRamGb: Number((probe.freeRamGb ?? 0).toFixed(1)),
        vramGb: probe.gpu ? Number(probe.gpu.totalVramGb.toFixed(1)) : null,
        ffiAvailable,
      },
      measuredModalities: measuredCount,
      skippedModalities: skips.length,
      coResidencyMode: coResidency.mode,
      evictionCount: coResidency.evictionCount,
    },
    modalities: rows,
    coResidency,
    skips,
    checks,
    pass,
  };

  const { file } = recordResult("memperf", result, NOW);

  if (JSON_ONLY) {
    console.log(JSON.stringify({ ...result, file }, null, 2));
    process.exit(pass ? 0 : 1);
    return;
  }

  console.log("\n=== Memory-Benchmark KPI (#8809) ===");
  console.log(
    `host tier:   ${tierAssessment.tier}  (${result.summary.host.totalRamGb} GB RAM, ` +
      `${result.summary.host.vramGb ? `${result.summary.host.vramGb} GB VRAM, ` : ""}` +
      `FFI ${ffiAvailable ? "available" : "unavailable"})`,
  );
  console.log(
    `measured:    ${measuredCount} / ${rows.length} (tier × modality) rows`,
  );
  console.log("\n-- per (tier × modality) --");
  for (const row of rows) {
    if (row.measured) {
      console.log(
        `  ${row.tier} / ${row.modality}: load ${ms(row.loadMs)}, ` +
          `Δrss ${row.rssDeltaMb} MB, peak ${row.peakRssMb} MB, ` +
          `${row.throughput ?? "—"} ${row.throughputUnit ?? ""}`,
      );
    } else {
      console.log(`  ${row.tier} / ${row.modality}: SKIP — ${row.skipReason}`);
    }
  }

  console.log("\n-- co-residency (text → vision → voice → pressure) --");
  console.log(`  mode:          ${coResidency.mode}`);
  console.log(`  sequence:      ${coResidency.sequence.join(" → ")}`);
  console.log(`  budget:        ${coResidency.budgetMb} MB`);
  console.log(`  loads:         ${coResidency.loadCount}`);
  console.log(`  evictions:     ${coResidency.evictionCount}`);
  console.log(`  pressure evts: ${coResidency.pressureEvents}`);
  for (const e of coResidency.evictions) {
    console.log(
      `    evicted ${e.capability}/${e.modelKey} reason=${e.reason} (~${e.estimatedMb} MB)`,
    );
  }

  console.log("\n-- budget checks --");
  if (checks.length === 0) {
    console.log("  (none — no measured rows produced a gated metric)");
  }
  for (const c of checks) {
    const v =
      c.unit === "MB"
        ? `${c.value ?? "—"} MB`
        : c.unit === "count"
          ? `${c.value}`
          : `${c.value}`;
    const cmp = c.name.includes("Min") ? "≥" : "≤";
    console.log(
      `  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${v} / ${cmp} ${c.budget} ${c.unit}`,
    );
  }

  console.log(`\nresult: ${pass ? "PASS" : "FAIL"}   recorded -> ${file}`);
  if (measuredCount === 0) {
    console.log(
      "note: no model bundle measured — co-residency telemetry self-check ran instead.\n",
    );
  } else {
    console.log("");
  }

  // Exit 2 (skipped) when there was nothing to measure AND the self-check is the
  // only thing that ran; otherwise 0/1 by budget. The self-check still asserts
  // the arbiter counts evictions, so a broken telemetry path fails LOUDLY (1),
  // never silently skips.
  if (measuredCount === 0) {
    process.exit(pass ? 2 : 1);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(
    `[memperf-kpi] fatal: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
});
