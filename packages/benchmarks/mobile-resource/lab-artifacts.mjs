/**
 * Physical lab artifact normalizer for the Mobile Resource Workbench (#12072).
 *
 * The live workbench records what the device can report directly. This tool
 * consumes the harder human-lab evidence that arrives later: power-meter CSVs,
 * physical iOS JSON captures, and exported workbench result JSON. It produces a
 * reviewer-readable report and a machine-readable summary without fabricating
 * missing measurements.
 *
 * Example:
 *   node packages/benchmarks/mobile-resource/lab-artifacts.mjs \
 *     --input=.github/issue-evidence/12072-lab \
 *     --out=packages/benchmarks/mobile-resource/results/lab \
 *     --fail-on-gaps
 */

import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  join,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "./lib.mjs";

const DEFAULT_MIN_RUNS = 3;
const EXPECTED_WORKLOADS = ["idle", "chat", "voice", "background"];
const EXPECTED_IOS_TIERS = ["eliza-1-2b", "eliza-1-4b"];

function isFiniteNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function field(row, names) {
  for (const name of names) {
    if (Object.hasOwn(row, name)) return row[name];
    const hit = Object.keys(row).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (hit) return row[hit];
  }
  return null;
}

function inferFromPath(file) {
  const lower = file.toLowerCase();
  const workload = EXPECTED_WORKLOADS.find((w) => lower.includes(w)) ?? null;
  const tier =
    EXPECTED_IOS_TIERS.find((t) => lower.includes(t.toLowerCase())) ?? null;
  const platform = lower.includes("ios")
    ? "ios"
    : lower.includes("android")
      ? "android"
      : null;
  const deviceClass =
    lower.includes("ios-phone") || lower.includes("iphone")
      ? "ios-phone"
      : lower.includes("android-phone") || lower.includes("pixel")
        ? "android-phone"
        : null;
  return { workload, tier, platform, deviceClass };
}

function mean(values) {
  const xs = values.filter(isFiniteNum);
  if (!xs.length) return null;
  return xs.reduce((sum, value) => sum + value, 0) / xs.length;
}

function stddev(values) {
  const xs = values.filter(isFiniteNum);
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(
    xs.reduce((sum, value) => sum + (value - m) ** 2, 0) / (xs.length - 1),
  );
}

function min(values) {
  const xs = values.filter(isFiniteNum);
  return xs.length ? Math.min(...xs) : null;
}

function max(values) {
  const xs = values.filter(isFiniteNum);
  return xs.length ? Math.max(...xs) : null;
}

function percentile(values, p) {
  const xs = values.filter(isFiniteNum).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
}

function coefficientOfVariation(values) {
  const m = mean(values);
  const s = stddev(values);
  if (!isFiniteNum(m) || m === 0 || !isFiniteNum(s)) return null;
  return s / Math.abs(m);
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
}

function splitCsvLine(line) {
  const out = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

function normalizeSample(row) {
  const atMs =
    numberOrNull(field(row, ["atMs", "elapsedMs", "elapsed_ms"])) ??
    secondsToMs(field(row, ["elapsedSeconds", "seconds", "time_s"]));
  const voltageV = numberOrNull(field(row, ["voltageV", "voltage_v", "V"]));
  const currentA = numberOrNull(field(row, ["currentA", "current_a", "A"]));
  const powerW =
    numberOrNull(field(row, ["powerW", "power_w", "watts", "W"])) ??
    (isFiniteNum(voltageV) && isFiniteNum(currentA)
      ? voltageV * currentA
      : null);
  return {
    atMs,
    workload: field(row, ["workload", "scenario"]) ?? null,
    tier: field(row, ["tier", "modelTier"]) ?? null,
    platform: field(row, ["platform", "os"]) ?? null,
    deviceClass: field(row, ["deviceClass", "device_class"]) ?? null,
    runId: field(row, ["runId", "run_id", "run"]) ?? null,
    source: field(row, ["source", "meter", "kind"]) ?? null,
    powerW,
    voltageV,
    currentA,
    energyWh: numberOrNull(field(row, ["energyWh", "energy_wh", "Wh"])),
    batteryLevelPct: numberOrNull(
      field(row, ["batteryLevelPct", "battery_pct", "batteryPct"]),
    ),
    residentMemoryMb: numberOrNull(
      field(row, ["residentMemoryMb", "rssMb", "rss_mb", "memoryMb"]),
    ),
    thermalState: field(row, ["thermalState", "thermal_state"]) ?? null,
    temperatureC: numberOrNull(field(row, ["temperatureC", "tempC", "temp_c"])),
    isCharging: parseBoolean(field(row, ["isCharging", "charging"])),
  };
}

function secondsToMs(value) {
  const n = numberOrNull(value);
  return n == null ? null : n * 1000;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "charging"].includes(normalized)) return true;
  if (["0", "false", "no", "discharging"].includes(normalized)) return false;
  return null;
}

function walkFiles(paths) {
  const files = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p))
        files.push(...walkFiles([join(p, name)]));
    } else if (/\.(csv|json)$/i.test(p)) {
      files.push(p);
    }
  }
  return files.sort();
}

function normalizeWorkbenchRecord(json, file) {
  if (!json || typeof json !== "object" || !json.summary) return null;
  const inferred = inferFromPath(file);
  const summary = json.summary;
  return {
    file,
    source: "workbench",
    platform: json.platform ?? inferred.platform,
    deviceClass: json.deviceClass ?? inferred.deviceClass,
    tier: json.tier ?? inferred.tier,
    workload: canonicalWorkload(json.workload ?? inferred.workload),
    runId: json.recordedAt ?? json.git?.commit ?? file,
    sampleCount: summary.resourceSamples ?? 0,
    durationMs: summary.battery?.durationMs ?? null,
    avgPowerW: null,
    energyWh: null,
    batteryDrainPct: summary.battery?.drainPct ?? null,
    peakRssMb: summary.rss?.peakMb ?? null,
    steadyRssMb: summary.rss?.steadyMb ?? null,
    ttftP90Ms: summary.ttftMs?.p90 ?? null,
    thermalMaxState: summary.thermal?.maxState ?? null,
    maxTemperatureC: null,
    chargingObserved: summary.battery?.chargingObserved ?? false,
    notes: ["workbench-result"],
  };
}

function canonicalWorkload(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (v.includes("single") || v.includes("chat") || v.includes("turn"))
    return "chat";
  if (v.includes("sustain")) return "chat";
  if (v.includes("voice")) return "voice";
  if (v.includes("idle") || v.includes("cold")) return "idle";
  if (v.includes("background") || v.includes("scheduled")) return "background";
  return v.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function summarizeSamples(samples, file) {
  const inferred = inferFromPath(file);
  const rows = samples.map(normalizeSample);
  const workload = canonicalWorkload(
    firstPresent(rows, "workload") ?? inferred.workload,
  );
  const tier = firstPresent(rows, "tier") ?? inferred.tier;
  const platform = firstPresent(rows, "platform") ?? inferred.platform;
  const deviceClass = firstPresent(rows, "deviceClass") ?? inferred.deviceClass;
  const at = rows.map((row) => row.atMs).filter(isFiniteNum);
  const power = rows.map((row) => row.powerW);
  const battery = rows.map((row) => row.batteryLevelPct);
  const rss = rows.map((row) => row.residentMemoryMb);
  const temp = rows.map((row) => row.temperatureC);
  const energyRows = rows.map((row) => row.energyWh).filter(isFiniteNum);
  const durationMs = at.length >= 2 ? max(at) - min(at) : null;
  const avgPowerW = mean(power);
  const energyWh = energyRows.length
    ? max(energyRows) - min(energyRows)
    : isFiniteNum(avgPowerW) && isFiniteNum(durationMs)
      ? avgPowerW * (durationMs / 3_600_000)
      : null;
  return {
    file,
    source: firstPresent(rows, "source") ?? "lab-samples",
    platform,
    deviceClass,
    tier,
    workload,
    runId: firstPresent(rows, "runId") ?? file,
    sampleCount: rows.length,
    durationMs,
    avgPowerW,
    energyWh,
    batteryDrainPct:
      battery.filter(isFiniteNum).length >= 2
        ? max(battery) - min(battery)
        : null,
    peakRssMb: max(rss),
    steadyRssMb: percentile(rss, 50),
    ttftP90Ms: null,
    thermalMaxState: maxThermalState(rows),
    maxTemperatureC: max(temp),
    chargingObserved: rows.some((row) => row.isCharging === true),
    notes: rows.some((row) => isFiniteNum(row.powerW))
      ? ["power-meter"]
      : ["sample-log"],
  };
}

function splitSamplesByRun(samples, file) {
  const normalized = samples.map((row) => ({
    original: row,
    sample: normalizeSample(row),
  }));
  const groups = new Map();
  for (const row of normalized) {
    const inferred = inferFromPath(file);
    const key = [
      row.sample.runId ?? file,
      canonicalWorkload(row.sample.workload ?? inferred.workload) ??
        "unknown-workload",
      row.sample.tier ?? inferred.tier ?? "unknown-tier",
      row.sample.platform ?? inferred.platform ?? "unknown-platform",
      row.sample.deviceClass ?? inferred.deviceClass ?? "unknown-device",
    ].join("|");
    const arr = groups.get(key) ?? [];
    arr.push(row.original);
    groups.set(key, arr);
  }
  return [...groups.values()];
}

function firstPresent(rows, key) {
  const found = rows.find((row) => row[key] != null && row[key] !== "");
  return found?.[key] ?? null;
}

function maxThermalState(rows) {
  const rank = { nominal: 0, fair: 1, serious: 2, critical: 3 };
  let best = null;
  let bestRank = -1;
  for (const row of rows) {
    const state = row.thermalState;
    if (state == null) continue;
    const r = rank[String(state).toLowerCase()];
    if (r != null && r > bestRank) {
      bestRank = r;
      best = String(state).toLowerCase();
    }
  }
  return best;
}

export function loadLabArtifacts(paths) {
  const records = [];
  const errors = [];
  for (const file of walkFiles(paths)) {
    try {
      const text = readFileSync(file, "utf8");
      if (/\.json$/i.test(file)) {
        const json = JSON.parse(text);
        const workbench = normalizeWorkbenchRecord(json, file);
        if (workbench) records.push(workbench);
        else if (Array.isArray(json))
          for (const group of splitSamplesByRun(json, file))
            records.push(summarizeSamples(group, file));
        else if (Array.isArray(json.samples))
          for (const group of splitSamplesByRun(json.samples, file))
            records.push(summarizeSamples(group, file));
      } else {
        const rows = parseCsv(text);
        if (rows.length)
          for (const group of splitSamplesByRun(rows, file))
            records.push(summarizeSamples(group, file));
      }
    } catch (err) {
      errors.push({ file, error: err.message });
    }
  }
  return { records, errors };
}

export function summarizeLabArtifacts(records, opts = {}) {
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
  const groups = new Map();
  for (const rec of records) {
    const key = [
      rec.platform ?? "unknown-platform",
      rec.deviceClass ?? "unknown-device",
      rec.tier ?? "unknown-tier",
      rec.workload ?? "unknown-workload",
    ].join("|");
    const arr = groups.get(key) ?? [];
    arr.push(rec);
    groups.set(key, arr);
  }

  const summaries = [...groups.entries()]
    .map(([key, runs]) => summarizeGroup(key, runs, minRuns))
    .sort((a, b) => a.key.localeCompare(b.key));
  const gaps = coverageGaps(summaries, { minRuns });
  return {
    minRuns,
    runCount: records.length,
    groups: summaries,
    gaps,
    pass: gaps.length === 0 && summaries.every((group) => group.stable),
  };
}

function summarizeGroup(key, runs, minRuns) {
  const [platform, deviceClass, tier, workload] = key.split("|");
  const energy = runs.map((run) => run.energyWh);
  const power = runs.map((run) => run.avgPowerW);
  const battery = runs.map((run) => run.batteryDrainPct);
  const peakRss = runs.map((run) => run.peakRssMb);
  const ttft = runs.map((run) => run.ttftP90Ms);
  const chargingObserved = runs.some((run) => run.chargingObserved);
  const energyCv = coefficientOfVariation(energy);
  const coolRuns = runs.filter((run) => {
    const tempOk = run.maxTemperatureC == null || run.maxTemperatureC < 43;
    const thermalOk =
      run.thermalMaxState == null ||
      ["nominal", "fair"].includes(run.thermalMaxState);
    return tempOk && thermalOk && !run.chargingObserved;
  }).length;
  const hasEnoughCoolRuns =
    runs.length >= minRuns && coolRuns >= minRuns && !chargingObserved;
  const stable =
    hasEnoughCoolRuns && (energyCv === null ? true : energyCv <= 0.15);
  return {
    key,
    platform,
    deviceClass,
    tier,
    workload,
    runs: runs.length,
    coolRuns,
    stable,
    chargingObserved,
    energyWh: stats(energy),
    avgPowerW: stats(power),
    batteryDrainPct: stats(battery),
    peakRssMb: stats(peakRss),
    ttftP90Ms: stats(ttft),
    files: runs.map((run) => run.file),
  };
}

function stats(values) {
  return {
    count: values.filter(isFiniteNum).length,
    mean: mean(values),
    min: min(values),
    max: max(values),
    stddev: stddev(values),
    cv: coefficientOfVariation(values),
  };
}

function coverageGaps(groups, { minRuns }) {
  const gaps = [];
  const byKey = new Map(groups.map((group) => [group.key, group]));
  for (const workload of EXPECTED_WORKLOADS) {
    const matching = groups.filter(
      (group) => group.workload === workload && group.energyWh.count > 0,
    );
    if (matching.length === 0)
      gaps.push(`missing power-meter energy evidence for ${workload}`);
  }
  for (const tier of EXPECTED_IOS_TIERS) {
    const key = ["ios", "ios-phone", tier, "chat"].join("|");
    const group = byKey.get(key);
    if (!group) gaps.push(`missing physical iOS chat metrics for ${tier}`);
    else if (group.runs < minRuns)
      gaps.push(`physical iOS ${tier} has ${group.runs}/${minRuns} runs`);
    else if (!group.stable)
      gaps.push(`physical iOS ${tier} runs are not stable/cool enough`);
  }
  for (const group of groups) {
    if (group.runs < minRuns)
      gaps.push(`${group.key} has ${group.runs}/${minRuns} runs`);
    if (group.chargingObserved)
      gaps.push(`${group.key} observed charging during a lab run`);
  }
  return [...new Set(gaps)].sort();
}

export function renderLabMarkdown(summary) {
  const lines = [];
  lines.push("# Mobile Resource Lab Artifact Report");
  lines.push("");
  lines.push(`Runs: ${summary.runCount}`);
  lines.push(`Minimum runs per stable group: ${summary.minRuns}`);
  lines.push(`Status: ${summary.pass ? "PASS" : "GAPS"}`);
  lines.push("");
  lines.push(
    "| Platform | Device | Tier | Workload | Runs | Cool | Energy Wh mean | Avg W mean | Peak RSS mean | Stable |",
  );
  lines.push(
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const group of summary.groups) {
    lines.push(
      `| ${group.platform} | ${group.deviceClass} | ${group.tier} | ${group.workload} | ${group.runs} | ${group.coolRuns} | ${fmt(group.energyWh.mean)} | ${fmt(group.avgPowerW.mean)} | ${fmt(group.peakRssMb.mean)} | ${group.stable ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Gaps");
  lines.push("");
  if (!summary.gaps.length) lines.push("_None._");
  else for (const gap of summary.gaps) lines.push(`- ${gap}`);
  lines.push("");
  return lines.join("\n");
}

function fmt(value) {
  return value == null ? "-" : Number(value).toFixed(3);
}

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name, fallback = null) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : fallback;
  };
  return {
    inputs: (get("input", "") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    out: get(
      "out",
      join("packages", "benchmarks", "mobile-resource", "results", "lab"),
    ),
    minRuns: numberOrNull(get("min-runs", null)) ?? DEFAULT_MIN_RUNS,
    failOnGaps: argv.includes("--fail-on-gaps"),
  };
}

function main() {
  const args = parseArgs();
  if (!args.inputs.length) {
    console.error(
      "[mobile-resource-lab] --input=<dir-or-file>[,...] is required",
    );
    process.exit(2);
  }
  const { records, errors } = loadLabArtifacts(args.inputs);
  const summary = summarizeLabArtifacts(records, { minRuns: args.minRuns });
  const report = renderLabMarkdown(summary);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    join(args.out, "lab-artifacts.json"),
    JSON.stringify({ ...summary, errors }, null, 2),
  );
  writeFileSync(join(args.out, "lab-artifacts.md"), report);
  console.log(report);
  if (errors.length)
    console.error(`[mobile-resource-lab] parse errors: ${errors.length}`);
  process.exit(args.failOnGaps && !summary.pass ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
