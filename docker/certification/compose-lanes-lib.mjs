/**
 * Pure derivation of the parallel-certification compose topology from the
 * test-runner's own plan (#14549). The single source of lane truth is
 * `packages/scripts/run-all-tests.mjs --plan=json --all`: each distinct
 * `scriptName` in the plan's `summary.byScript` becomes one lane (optionally
 * split into TEST_SHARD slices the runner itself understands), and the plan's
 * `cloudStep` becomes the dedicated cloud lane — there is deliberately no
 * second lane registry to drift from the runner.
 *
 * Everything here is side-effect-free (no fs, no spawn, no clock) so the shard
 * math, cpuset allocation, and YAML rendering are unit-testable and the
 * committed compose.yml is byte-reproducible: generate-compose-lanes.mjs feeds
 * in the live plan and writes the rendered text; the drift test regenerates
 * and compares. Rendering is a hand-rolled emitter over a fixed key order —
 * a generic YAML library would not guarantee byte stability across versions.
 */

/** Generator parameters baked into the committed compose.yml. Fixed defaults
 * (not `os.cpus()`) so regeneration is machine-independent. */
export const DEFAULT_PARAMS = Object.freeze({
  cores: 16,
  unitShards: 4,
  e2eShards: 2,
  gpuParallel: 4,
});

/** Matches serve.mjs CONTEXT_SIZE — one context budget for native and compose. */
export const GPU_CONTEXT_SIZE = 8192;

const CPU_IMAGE =
  "${ELIZA_CERT_IMAGE:-ghcr.io/elizaos/certification-gpu:latest}";
const GPU_IMAGE =
  "${ELIZA_CERT_GPU_IMAGE:-ghcr.io/elizaos/certification-gpu:latest}";
const REPO_MOUNT = "${ELIZA_REPO_ROOT:-../..}:/repo:ro";
const QUEUE_MOUNT = "${ELIZA_CERT_QUEUE_HOST:-./queue}:/queue";
const MODELS_MOUNT =
  "${ELIZA_GPU_MODELS_DIR:-~/.cache/eliza/gpu-vision}:/models:ro";

/** Positive-integer guard for generator parameters; a zero/NaN shard count
 * must fail here, not surface as a broken TEST_SHARD spec inside a container. */
export function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `[compose-lanes] ${label} must be a positive integer, got: ${value}`,
    );
  }
  return value;
}

/** Lane base name for a plan scriptName: `test` → `unit`, `test:e2e` → `e2e`. */
export function laneBaseName(scriptName) {
  if (scriptName === "test") return "unit";
  return scriptName
    .replace(/^test:/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

/**
 * Derive the lane list from a `--plan=json --all` document. Script lanes run
 * `run-all-tests.mjs` filtered to one scriptName (sharded via the runner's own
 * TEST_SHARD for the big groups); the plan's cloudStep command becomes the
 * `cloud` lane so `--no-cloud` on the script lanes loses no coverage.
 */
export function deriveLanes(plan, params = DEFAULT_PARAMS) {
  const byScript = plan?.summary?.byScript;
  if (
    !byScript ||
    typeof byScript !== "object" ||
    Object.keys(byScript).length === 0
  ) {
    throw new Error(
      "[compose-lanes] plan has no summary.byScript — expected run-all-tests.mjs --plan=json --all output",
    );
  }
  assertPositiveInteger(params.unitShards, "unitShards");
  assertPositiveInteger(params.e2eShards, "e2eShards");

  const lanes = [];
  for (const scriptName of Object.keys(byScript).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const base = laneBaseName(scriptName);
    const total =
      scriptName === "test"
        ? params.unitShards
        : scriptName === "test:e2e"
          ? params.e2eShards
          : 1;
    for (let index = 1; index <= total; index++) {
      lanes.push({
        name: total > 1 ? `${base}-${index}of${total}` : base,
        kind: "run-all-tests",
        script: scriptName,
        shard: total > 1 ? `${index}/${total}` : null,
      });
    }
  }
  if (plan.cloudStep && typeof plan.cloudStep.command === "string") {
    lanes.push({
      name: "cloud",
      kind: "command",
      command: plan.cloudStep.command,
      script: null,
      shard: null,
    });
  }

  const seen = new Set();
  for (const lane of lanes) {
    if (seen.has(lane.name)) {
      throw new Error(
        `[compose-lanes] duplicate lane name derived from plan: ${lane.name}`,
      );
    }
    seen.add(lane.name);
  }
  return lanes;
}

/**
 * Partition `totalCores` into contiguous cpuset ranges, one per lane, in lane
 * order. The remainder cores go to the earliest lanes — derivation order puts
 * the heavy `unit`/`e2e` shards first, so they absorb the extras. More lanes
 * than cores is a sizing error the caller must resolve (fewer shards or more
 * cores), never silent oversubscription of a pinned set.
 */
export function allocateCpusets(totalCores, laneCount) {
  assertPositiveInteger(totalCores, "cores");
  assertPositiveInteger(laneCount, "lane count");
  if (laneCount > totalCores) {
    throw new Error(
      `[compose-lanes] ${laneCount} lanes need at least ${laneCount} cores but only ${totalCores} configured — ` +
        "lower --unit-shards/--e2e-shards or raise --cores",
    );
  }
  const base = Math.floor(totalCores / laneCount);
  const remainder = totalCores % laneCount;
  const allocations = [];
  let next = 0;
  for (let i = 0; i < laneCount; i++) {
    const size = base + (i < remainder ? 1 : 0);
    const first = next;
    const last = next + size - 1;
    next = last + 1;
    allocations.push({
      cpuset: size === 1 ? `${first}` : `${first}-${last}`,
      cpus: size,
    });
  }
  return allocations;
}

/** The shell command a script lane runs inside its container (via lane-entry.sh).
 * `--no-cloud` is safe because the plan-derived `cloud` lane carries that step. */
export function laneCommand(lane) {
  if (lane.kind === "command") return lane.command;
  return "node packages/scripts/run-all-tests.mjs --no-cloud --min-tasks=1";
}

/** Compose interpolation treats `$` specially; env values that must reach the
 * container verbatim (anchored regexes like `^test$`) need `$$`. */
export function escapeComposeValue(value) {
  return value.replace(/\$/g, "$$$$");
}

/**
 * Assemble the full compose document model: cpu-profile lane services with
 * cpuset pinning + cpu quotas, the single GPU-owning vision service (both
 * resident llama-servers live in that one container — lanes share the service
 * over HTTP, never the device), and the queue worker.
 */
export function buildComposeModel(plan, params, modelSets) {
  const lanes = deriveLanes(plan, params);
  const allocations = allocateCpusets(params.cores, lanes.length);
  assertPositiveInteger(params.gpuParallel, "gpuParallel");
  const ocr = modelSets?.ocr;
  const vlm = modelSets?.vlm;
  if (!ocr?.files?.model?.name || !vlm?.files?.model?.name) {
    throw new Error(
      "[compose-lanes] MODEL_SETS missing ocr/vlm entries (scripts/gpu-vision/lib.mjs)",
    );
  }

  const services = [];
  lanes.forEach((lane, i) => {
    const environment = {
      BUN_INSTALL_CACHE_DIR: "/cache/bun",
      ELIZA_CERT_QUEUE_DIR: "/queue",
      LANE_COMMAND: laneCommand(lane),
      LANE_NAME: lane.name,
    };
    if (lane.kind === "run-all-tests") {
      environment.TEST_LANE = "pr";
      environment.TEST_SCRIPT_FILTER = `^${lane.script}$`;
      if (lane.shard) environment.TEST_SHARD = lane.shard;
    }
    services.push({
      name: `lane-${lane.name}`,
      lane: lane.name,
      image: CPU_IMAGE,
      profiles: ["cpu"],
      command: ["bash", "/repo/docker/certification/lane-entry.sh"],
      cpuset: allocations[i].cpuset,
      cpus: allocations[i].cpus,
      environment,
      volumes: [
        REPO_MOUNT,
        `scratch-lane-${lane.name}:/work`,
        "build-cache:/cache",
        QUEUE_MOUNT,
      ],
    });
  });

  services.push({
    name: "gpu-vision",
    image: GPU_IMAGE,
    profiles: ["gpu"],
    command: ["bash", "/repo/docker/certification/gpu-entry.sh"],
    environment: {
      LLAMA_CONTEXT: `${GPU_CONTEXT_SIZE}`,
      LLAMA_PARALLEL: `${params.gpuParallel}`,
      OCR_MMPROJ: `/models/ocr/${ocr.files.mmproj.name}`,
      OCR_MODEL: `/models/ocr/${ocr.files.model.name}`,
      OCR_PORT: "8090",
      VLM_MMPROJ: `/models/vlm/${vlm.files.mmproj.name}`,
      VLM_MODEL: `/models/vlm/${vlm.files.model.name}`,
      VLM_PORT: "8091",
    },
    volumes: [REPO_MOUNT, MODELS_MOUNT],
    gpu: true,
    healthcheck: {
      test: [
        "CMD-SHELL",
        "curl -fsS http://127.0.0.1:8090/health && curl -fsS http://127.0.0.1:8091/health",
      ],
      interval: "10s",
      timeout: "5s",
      retries: 60,
      start_period: "120s",
    },
  });

  services.push({
    name: "gpu-queue-worker",
    image: GPU_IMAGE,
    profiles: ["gpu"],
    command: [
      "node",
      "/repo/docker/certification/queue-worker.mjs",
      "--jobs",
      "/queue",
      "--service",
      "ocr=http://gpu-vision:8090",
      "--service",
      "vlm=http://gpu-vision:8091",
    ],
    dependsOnHealthy: ["gpu-vision"],
    volumes: [REPO_MOUNT, QUEUE_MOUNT],
  });

  return {
    lanes,
    services,
    params,
    scripts: Object.keys(plan.summary.byScript).sort(),
  };
}

function yamlValue(value) {
  if (typeof value === "number") return `${value}`;
  // Quote every string: compose values include `${…}` defaults, `^…$$` regexes,
  // and `no` / `0-3` scalars YAML would otherwise coerce; uniform quoting keeps
  // the emitter trivially deterministic.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderList(lines, indent, items) {
  for (const item of items) lines.push(`${indent}- ${yamlValue(item)}`);
}

/** Render the compose model to the exact committed YAML text. */
export function renderCompose(model) {
  const { params, scripts } = model;
  const lines = [];
  lines.push(
    "# Single-machine parallel certification stack (#14549, epic #14541).",
    "# GENERATED by docker/certification/generate-compose-lanes.mjs from the test",
    "# runner's own plan (`run-all-tests.mjs --plan=json --all`) — the lane",
    "# services mirror that plan's script groups; do not edit by hand.",
    "#   Regenerate: node docker/certification/generate-compose-lanes.mjs",
    "#   Drift check: node docker/certification/generate-compose-lanes.mjs --check",
    `# Params: cores=${params.cores} unit-shards=${params.unitShards} e2e-shards=${params.e2eShards} gpu-parallel=${params.gpuParallel}`,
    `# Plan scripts: ${scripts.join(", ")} (+ cloud step)`,
    "",
    "name: eliza-certification",
    "",
    "services:",
  );

  for (const service of model.services) {
    lines.push(`  ${service.name}:`);
    lines.push(`    image: ${service.image}`);
    if (service.profiles) {
      lines.push("    profiles:");
      renderList(lines, "      ", service.profiles);
    }
    if (service.dependsOnHealthy) {
      lines.push("    depends_on:");
      for (const dep of service.dependsOnHealthy) {
        lines.push(`      ${dep}:`);
        lines.push("        condition: service_healthy");
      }
    }
    lines.push("    command:");
    renderList(lines, "      ", service.command);
    if (service.cpuset !== undefined) {
      lines.push(`    cpuset: ${yamlValue(service.cpuset)}`);
      lines.push(`    cpus: ${service.cpus}`);
    }
    if (service.environment && Object.keys(service.environment).length > 0) {
      lines.push("    environment:");
      for (const key of Object.keys(service.environment).sort((a, b) =>
        a.localeCompare(b),
      )) {
        lines.push(
          `      ${key}: ${yamlValue(escapeComposeValue(service.environment[key]))}`,
        );
      }
    }
    if (service.volumes) {
      lines.push("    volumes:");
      renderList(lines, "      ", service.volumes);
    }
    if (service.gpu) {
      lines.push(
        "    deploy:",
        "      resources:",
        "        reservations:",
        "          devices:",
        '            - driver: "nvidia"',
        "              count: 1",
        "              capabilities:",
        '                - "gpu"',
      );
    }
    if (service.healthcheck) {
      lines.push("    healthcheck:");
      lines.push("      test:");
      renderList(lines, "        ", service.healthcheck.test);
      lines.push(`      interval: ${service.healthcheck.interval}`);
      lines.push(`      timeout: ${service.healthcheck.timeout}`);
      lines.push(`      retries: ${service.healthcheck.retries}`);
      lines.push(`      start_period: ${service.healthcheck.start_period}`);
    }
    lines.push('    restart: "no"');
    lines.push("");
  }

  lines.push("volumes:");
  lines.push("  build-cache: {}");
  for (const lane of model.lanes) {
    lines.push(`  scratch-lane-${lane.name}: {}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Parse generator/orchestrator shared CLI params on top of DEFAULT_PARAMS. */
export function resolveParams(flags) {
  const read = (key, fallback, label) => {
    const raw = flags[key];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return assertPositiveInteger(value, label);
  };
  return {
    cores: read("cores", DEFAULT_PARAMS.cores, "--cores"),
    unitShards: read("unit-shards", DEFAULT_PARAMS.unitShards, "--unit-shards"),
    e2eShards: read("e2e-shards", DEFAULT_PARAMS.e2eShards, "--e2e-shards"),
    gpuParallel: read(
      "gpu-parallel",
      DEFAULT_PARAMS.gpuParallel,
      "--gpu-parallel",
    ),
  };
}

/** True when the resolved params match the committed defaults — the only case
 * where the orchestrator holds the generated text against compose.yml. */
export function paramsAreDefault(params) {
  return (
    params.cores === DEFAULT_PARAMS.cores &&
    params.unitShards === DEFAULT_PARAMS.unitShards &&
    params.e2eShards === DEFAULT_PARAMS.e2eShards &&
    params.gpuParallel === DEFAULT_PARAMS.gpuParallel
  );
}
