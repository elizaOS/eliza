#!/usr/bin/env node
/**
 * Automated full-tier certification runs on vast.ai (#14548, epic #14541).
 * Searches cheap verified RTX 4090 offers, rents the cheapest one from the
 * prebuilt certification image, runs the certification chain on the instance
 * via onstart (clone @ --sha → bundle:create → certify:rollup → certify:sign,
 * from packages/evidence), pulls the signed certification.json back through
 * the instance logs, and ALWAYS destroys the instance in a finally block —
 * never "stop", because stopped vast instances keep billing disk.
 *
 * Plain node with zero workspace imports so the certification-vast.yml
 * workflow (and a laptop) can run it without a bun install. The pure pieces —
 * offer filtering/sorting, onstart assembly + the 16 KB vast onstart cap,
 * the poll state machine, and the budget guard — are exported for
 * run-certification.test.mjs; only main() touches the network.
 *
 * Secrets discipline: the Ed25519 signing key (ELIZA_CERT_SIGNING_KEY) and
 * the optional storage push command (CERT_PUSH_CMD, may embed credentials)
 * travel ONLY in the create-instance env payload, never in the onstart text,
 * never in logs or the --dry-run plan. Every failure path exits with a
 * distinct code (see EXIT) and a one-line reason; a failed destroy prints the
 * instance id loudly so a human can kill the billing by hand.
 */

import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const API_BASE = "https://console.vast.ai/api/v0";
export const DEFAULT_IMAGE = "ghcr.io/elizaos/certification-gpu:latest";
export const DEFAULT_REPO_URL = "https://github.com/elizaOS/eliza.git";
/** vast.ai rejects onstart-cmd payloads larger than 16 KB. */
export const ONSTART_MAX_BYTES = 16 * 1024;
export const SIGNING_KEY_ENV_VAR = "ELIZA_CERT_SIGNING_KEY";
export const PUSH_CMD_ENV_VAR = "CERT_PUSH_CMD";
export const API_KEY_ENV_VAR = "VAST_API_KEY";
export const TIERS = ["cpu", "gpu", "full"];

/** Log markers the onstart script emits; the poller keys terminal states off them. */
export const SUCCESS_MARKER = "ELIZA-CERT-RUN-SUCCESS";
export const FAILURE_MARKER = "ELIZA-CERT-RUN-FAILURE";
export const CERT_BEGIN_MARKER = "-----BEGIN ELIZA CERTIFICATION JSON-----";
export const CERT_END_MARKER = "-----END ELIZA CERTIFICATION JSON-----";

/**
 * One distinct exit code per kill path so the workflow (and the runbook's
 * kill-path table) can name the failure without parsing prose.
 */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  DEAD_API_KEY: 3,
  NO_OFFERS: 4,
  BUDGET_EXCEEDED: 5,
  CREATE_FAILED: 6,
  STUCK_LOADING: 7,
  RUN_TIMEOUT: 8,
  INSTANCE_LOST: 9,
  ONSTART_FAILED: 10,
  RESULTS_PULL_FAILED: 11,
  DESTROY_FAILED: 12,
};

export class UsageError extends Error {}

/**
 * API error carrying the HTTP status and vast's structured error code so
 * auth failures map to DEAD_API_KEY. vast does NOT use 401 for a dead key:
 * it answers HTTP 404 with {"success":false,"error":"auth_error","msg":
 * "Invalid user key"} (verified against the live API), so the body's error
 * code is the reliable signal and bare status codes are only a fallback.
 */
export class VastApiError extends Error {
  constructor(message, { status, body, errorCode } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.errorCode = errorCode;
  }
  get isAuthFailure() {
    return (
      this.errorCode === "auth_error" ||
      this.status === 401 ||
      this.status === 403
    );
  }
}

/** Pull vast's machine-readable error code out of a failure body, if any. */
export function parseVastErrorCode(bodyText) {
  if (typeof bodyText !== "string") return undefined;
  try {
    const parsed = JSON.parse(bodyText);
    return typeof parsed?.error === "string" ? parsed.error : undefined;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — vast serves HTML error
    // pages for some failures; "no structured code" is the explicit result.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CLI parsing

const DEFAULTS = {
  gpuName: "RTX_4090",
  numGpus: 1,
  minReliability: 0.98,
  minInetDown: 500,
  maxDph: 0.6,
  maxAttempts: 3,
  timeoutMinutes: 120,
  loadingTimeoutMinutes: 20,
  pollIntervalSeconds: 15,
  image: DEFAULT_IMAGE,
  diskGb: 80,
  tier: "full",
  repoUrl: DEFAULT_REPO_URL,
  reviewerId: "vast-certification-runner",
  outDir: "vast-certification-output",
};

const USAGE = `Usage: node scripts/vast/run-certification.mjs --sha <commit> [options]

Required:
  --sha <commit>              Full commit sha to certify (cloned on the instance)

Options:
  --tier <cpu|gpu|full>       Certification tier (default: ${DEFAULTS.tier})
  --image <ref>               Docker image (default: ${DEFAULTS.image})
  --repo-url <url>            Repo to clone on the instance (default: ${DEFAULTS.repoUrl})
  --gpu-name <name>           Offer GPU filter, underscores for spaces (default: ${DEFAULTS.gpuName})
  --max-dph <usd>             Budget cap in $/hr; offers above are rejected (default: ${DEFAULTS.maxDph})
  --max-attempts <n>          Max offers tried before giving up (default: ${DEFAULTS.maxAttempts})
  --timeout-minutes <n>       Hard wall-clock cap per attempt (default: ${DEFAULTS.timeoutMinutes})
  --loading-timeout-minutes <n>  Cap on the loading/provisioning phase (default: ${DEFAULTS.loadingTimeoutMinutes})
  --disk-gb <n>               Instance disk allocation (default: ${DEFAULTS.diskGb})
  --reviewer-id <id>          Reviewer identity baked into the signed cert (default: ${DEFAULTS.reviewerId})
  --push-cmd <shell>          Command run on-instance to push bundle+cert to storage
                              (else env ${PUSH_CMD_ENV_VAR}; gets CERT_BUNDLE_DIR/CERT_FILE)
  --out <dir>                 Where pulled logs + certification.json land (default: ${DEFAULTS.outDir})
  --api-key <key>             vast.ai API key (else env ${API_KEY_ENV_VAR})
  --dry-run                   Print the full plan (query, payload, onstart, budget) with ZERO API calls
  --help                      This text

Signing key: env ${SIGNING_KEY_ENV_VAR} (required unless --dry-run); injected into the
instance env at create time only — never written into the onstart text or this plan.`;

/** Parse argv (no positionals). Throws UsageError; never exits — main() maps to EXIT.USAGE. */
export function parseCliArgs(argv, env = {}) {
  const opts = { ...DEFAULTS, dryRun: false, sha: undefined };
  opts.apiKey = env[API_KEY_ENV_VAR];
  opts.pushCmd = env[PUSH_CMD_ENV_VAR];
  opts.signingKey = env[SIGNING_KEY_ENV_VAR];

  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  };
  const takeNumber = (flag, index, { integer = false, min } = {}) => {
    const raw = takeValue(flag, index);
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      (integer && !Number.isInteger(value)) ||
      (min !== undefined && value < min)
    ) {
      throw new UsageError(
        `${flag} must be a${integer ? "n integer" : " number"}${min !== undefined ? ` >= ${min}` : ""}, got: ${raw}`,
      );
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--sha":
        opts.sha = takeValue(arg, index);
        index += 1;
        break;
      case "--tier": {
        const tier = takeValue(arg, index);
        if (!TIERS.includes(tier)) {
          throw new UsageError(
            `--tier must be one of ${TIERS.join("|")}, got: ${tier}`,
          );
        }
        opts.tier = tier;
        index += 1;
        break;
      }
      case "--image":
        opts.image = takeValue(arg, index);
        index += 1;
        break;
      case "--repo-url":
        opts.repoUrl = takeValue(arg, index);
        index += 1;
        break;
      case "--gpu-name":
        opts.gpuName = takeValue(arg, index);
        index += 1;
        break;
      case "--max-dph":
        opts.maxDph = takeNumber(arg, index, { min: 0.01 });
        index += 1;
        break;
      case "--max-attempts":
        opts.maxAttempts = takeNumber(arg, index, { integer: true, min: 1 });
        index += 1;
        break;
      case "--timeout-minutes":
        opts.timeoutMinutes = takeNumber(arg, index, { min: 1 });
        index += 1;
        break;
      case "--loading-timeout-minutes":
        opts.loadingTimeoutMinutes = takeNumber(arg, index, { min: 1 });
        index += 1;
        break;
      case "--disk-gb":
        opts.diskGb = takeNumber(arg, index, { integer: true, min: 10 });
        index += 1;
        break;
      case "--reviewer-id":
        opts.reviewerId = takeValue(arg, index);
        index += 1;
        break;
      case "--push-cmd":
        opts.pushCmd = takeValue(arg, index);
        index += 1;
        break;
      case "--out":
        opts.outDir = takeValue(arg, index);
        index += 1;
        break;
      case "--api-key":
        opts.apiKey = takeValue(arg, index);
        index += 1;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (opts.help) return opts;
  if (!opts.sha || !/^[0-9a-f]{7,40}$/i.test(opts.sha)) {
    throw new UsageError(
      "--sha is required and must be a git commit sha (7-40 hex chars)",
    );
  }
  if (!opts.dryRun) {
    if (!opts.apiKey) {
      throw new UsageError(
        `no vast.ai API key: pass --api-key or set ${API_KEY_ENV_VAR}`,
      );
    }
    if (!opts.signingKey) {
      throw new UsageError(
        `no signing key: set ${SIGNING_KEY_ENV_VAR} (PEM or base64-wrapped PEM)`,
      );
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Offer search + budget guard

/**
 * Server-side search query for PUT /search/asks/. vast's own CLI writes GPU
 * names with spaces ("RTX 4090") but its flag syntax uses underscores; we
 * accept the underscore form and translate here.
 */
export function buildOfferQuery(opts) {
  return {
    gpu_name: { eq: opts.gpuName.replaceAll("_", " ") },
    num_gpus: { eq: opts.numGpus },
    verified: { eq: true },
    rentable: { eq: true },
    reliability2: { gt: opts.minReliability },
    inet_down: { gt: opts.minInetDown },
    dph_total: { lte: opts.maxDph },
    type: "ask",
    order: [["dph_total", "asc"]],
  };
}

/**
 * Client-side re-check of everything the server query already promised, plus
 * the budget cap. The server-side query language has drifted before (e.g.
 * reliability vs reliability2); trusting it blindly risks renting a machine
 * that violates the acceptance filters. Offers missing a numeric field are
 * rejected, never assumed compliant. Returns eligible offers sorted cheapest
 * first (reliability desc as tie-break) and the rejects with reasons for the
 * failure summary.
 */
export function filterAndSortOffers(offers, opts) {
  const eligible = [];
  const rejected = [];
  for (const offer of offers) {
    const reliability =
      typeof offer.reliability2 === "number"
        ? offer.reliability2
        : offer.reliability;
    const reason = (() => {
      if (typeof offer.id !== "number") return "missing offer id";
      if (typeof offer.dph_total !== "number") return "missing dph_total";
      if (offer.dph_total > opts.maxDph) {
        return `dph_total ${offer.dph_total.toFixed(4)} > --max-dph ${opts.maxDph}`;
      }
      if (typeof reliability !== "number") return "missing reliability";
      if (reliability <= opts.minReliability) {
        return `reliability ${reliability} <= ${opts.minReliability}`;
      }
      if (
        typeof offer.inet_down !== "number" ||
        offer.inet_down <= opts.minInetDown
      ) {
        return `inet_down ${offer.inet_down} <= ${opts.minInetDown}`;
      }
      if (offer.num_gpus !== opts.numGpus)
        return `num_gpus ${offer.num_gpus} != ${opts.numGpus}`;
      return null;
    })();
    if (reason === null) {
      eligible.push({ ...offer, reliabilityResolved: reliability });
    } else {
      rejected.push({ id: offer.id, reason });
    }
  }
  eligible.sort(
    (a, b) =>
      a.dph_total - b.dph_total ||
      b.reliabilityResolved - a.reliabilityResolved,
  );
  return { eligible, rejected };
}

/**
 * Budget guard: which offers may actually be attempted. Cheapest-first,
 * capped by --max-attempts; every offer already passed the --max-dph cap in
 * filterAndSortOffers, so total worst-case spend is bounded by
 * maxAttempts * maxDph * timeoutHours.
 */
export function selectAttemptOffers(eligible, opts) {
  return eligible.slice(0, opts.maxAttempts);
}

// ---------------------------------------------------------------------------
// Onstart assembly

/**
 * The script vast runs inside the container on boot. Everything heavy
 * (models, browsers, toolchains) is baked into the image; this only clones
 * the repo at the exact sha, installs workspace deps, and runs the
 * certification chain. It deliberately contains NO secrets: the signing key
 * and push command arrive via the create-payload env (docker -e), so the
 * onstart text is safe to print in --dry-run and store server-side.
 *
 * Every step failure prints "${FAILURE_MARKER}: <step>" — the poller treats
 * that marker (or an exit without the success marker) as ONSTART_FAILED. The
 * signed certification.json is emitted between BEGIN/END markers so the
 * controller can recover it from the instance logs even when no push command
 * is configured (the full bundle is too big for logs and needs CERT_PUSH_CMD).
 */
export function buildOnstart(opts) {
  const lines = [
    "#!/bin/bash",
    "set -uo pipefail",
    `fail() { echo "${FAILURE_MARKER}: $1"; exit 1; }`,
    `echo "[cert-run] begin sha=${opts.sha} tier=${opts.tier}"`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash env expansion, not a JS template
    "export HOME=${HOME:-/root}",
    'export PATH="$HOME/.bun/bin:$PATH"',
    "export ELIZA_EVIDENCE_RUNNER=vast",
    "mkdir -p /workspace && cd /workspace || fail workspace",
    "rm -rf eliza && mkdir eliza && cd eliza",
    "git init -q -b certification || fail git-init",
    `git remote add origin '${opts.repoUrl}' || fail git-remote`,
    // Blobless-shallow fetch of the exact sha: the monorepo history is huge
    // and the certification binds to one commit anyway.
    `git fetch --depth 1 origin ${opts.sha} || fail fetch-sha`,
    "git checkout -q FETCH_HEAD || fail checkout",
    "bun run install:light || fail install",
    // GPU vision lane, as available: the image bakes llama-server + pinned
    // models; a cpu-tier image without them skips explicitly instead of
    // half-starting.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash env expansion, not a JS template
    'if command -v llama-server >/dev/null 2>&1 && [ -n "${ELIZA_GPU_VISION_CACHE:-}" ]; then',
    "  node scripts/gpu-vision/serve.mjs --vlm --verify || fail gpu-vision-serve",
    "else",
    '  echo "[cert-run] gpu-vision service unavailable in this image; vision lanes will record as absent"',
    "fi",
    `bun run --cwd packages/evidence bundle:create -- --tier ${opts.tier} || fail bundle-create`,
    // Absolute path: the certify steps below run with cwd packages/evidence
    // (bun run --cwd), so a repo-root-relative bundle path would not resolve.
    'BUNDLE_DIR="$(ls -td "$PWD"/evidence/runs/*/ 2>/dev/null | head -1)"',
    '[ -n "$BUNDLE_DIR" ] || fail bundle-dir',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash env expansion, not a JS template
    'BUNDLE_DIR="${BUNDLE_DIR%/}"',
    'bun run --cwd packages/evidence certify:rollup -- --bundle "$BUNDLE_DIR" --out "$BUNDLE_DIR/verdicts.json" || fail rollup',
    `bun run --cwd packages/evidence certify:sign -- --bundle "$BUNDLE_DIR" --verdicts "$BUNDLE_DIR/verdicts.json" --reviewer-id '${opts.reviewerId}' --reviewer-kind agent || fail sign`,
    `echo "${CERT_BEGIN_MARKER}"`,
    'cat "$BUNDLE_DIR/certification.json" || fail cert-read',
    'echo ""',
    `echo "${CERT_END_MARKER}"`,
    `if [ -n "\${${PUSH_CMD_ENV_VAR}:-}" ]; then`,
    '  export CERT_BUNDLE_DIR="$BUNDLE_DIR"',
    '  export CERT_FILE="$BUNDLE_DIR/certification.json"',
    `  bash -c "$${PUSH_CMD_ENV_VAR}" || fail push`,
    "else",
    '  echo "[cert-run] no CERT_PUSH_CMD configured; bundle stays on the instance (certification travels via logs)"',
    "fi",
    `echo "${SUCCESS_MARKER}"`,
  ];
  return `${lines.join("\n")}\n`;
}

/** vast rejects onstart payloads over 16 KB; fail before spending money. */
export function assertOnstartSize(onstart) {
  const bytes = Buffer.byteLength(onstart, "utf8");
  if (bytes > ONSTART_MAX_BYTES) {
    throw new UsageError(
      `onstart script is ${bytes} bytes; vast caps onstart-cmd at ${ONSTART_MAX_BYTES}. ` +
        "Move logic into the baked image or shorten the embedded values (--repo-url, --reviewer-id).",
    );
  }
  return bytes;
}

/**
 * PUT /asks/{offer_id}/ payload. Secrets live only here (env → docker -e).
 * runtype ssh keeps the container alive after onstart so logs stay pullable;
 * lifecycle is bounded by our destroy-in-finally, not container exit.
 */
export function buildCreatePayload(opts, onstart) {
  const env = { ELIZA_EVIDENCE_RUNNER: "vast" };
  if (opts.signingKey) env[SIGNING_KEY_ENV_VAR] = opts.signingKey;
  if (opts.pushCmd) env[PUSH_CMD_ENV_VAR] = opts.pushCmd;
  return {
    client_id: "me",
    image: opts.image,
    env,
    onstart,
    runtype: "ssh",
    disk: opts.diskGb,
    label: `eliza-certification-${opts.sha.slice(0, 12)}`,
  };
}

/** Dry-run/logging view of the create payload: env values never printed. */
export function redactCreatePayload(payload) {
  return {
    ...payload,
    env: Object.fromEntries(
      Object.keys(payload.env).map((key) => [key, "<redacted>"]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Poll state machine

const LOADING_STATUSES = new Set(["", "loading", "created", "connecting"]);
const LOST_STATUSES = new Set(["offline", "unknown", "deleted"]);

/**
 * Pure reducer over instance snapshots so every kill path is unit-testable
 * without a network. Feed it {actualStatus, elapsedMs, marker} on each poll
 * tick; it returns a new state whose .outcome is set once terminal:
 *   {ok:true}                                — success marker seen in logs
 *   {ok:false, code, reason}                 — one of the EXIT kill paths
 * offline/unknown are debounced (offlineGraceCount consecutive sightings)
 * because the vast API intermittently blips those for healthy instances.
 */
export function createPollState({
  timeoutMs,
  loadingTimeoutMs,
  offlineGraceCount = 3,
}) {
  return {
    timeoutMs,
    loadingTimeoutMs,
    offlineGraceCount,
    consecutiveLost: 0,
    sawRunning: false,
    outcome: null,
  };
}

export function reducePoll(state, snapshot) {
  if (state.outcome) return state;
  const { elapsedMs, marker } = snapshot;
  const actualStatus =
    typeof snapshot.actualStatus === "string" ? snapshot.actualStatus : "";
  const next = { ...state };

  if (marker === "failure") {
    next.outcome = {
      ok: false,
      code: EXIT.ONSTART_FAILED,
      reason: "onstart reported failure (see pulled logs for the failing step)",
    };
    return next;
  }
  if (marker === "success") {
    next.outcome = { ok: true };
    return next;
  }
  if (actualStatus === "exited") {
    // Container stopped without ever printing the success marker: the run
    // died (OOM, docker pull failure surfaced late, onstart killed).
    next.outcome = {
      ok: false,
      code: EXIT.ONSTART_FAILED,
      reason: "instance exited without the success marker",
    };
    return next;
  }
  if (LOST_STATUSES.has(actualStatus)) {
    next.consecutiveLost = state.consecutiveLost + 1;
    if (next.consecutiveLost >= state.offlineGraceCount) {
      next.outcome = {
        ok: false,
        code: EXIT.INSTANCE_LOST,
        reason: `instance ${actualStatus} for ${next.consecutiveLost} consecutive polls`,
      };
    }
    return next;
  }
  next.consecutiveLost = 0;
  if (actualStatus === "running") next.sawRunning = true;

  if (elapsedMs > state.timeoutMs) {
    next.outcome = {
      ok: false,
      code: EXIT.RUN_TIMEOUT,
      reason: `run exceeded --timeout-minutes (${Math.round(state.timeoutMs / 60000)}m)`,
    };
    return next;
  }
  if (
    !next.sawRunning &&
    LOADING_STATUSES.has(actualStatus) &&
    elapsedMs > state.loadingTimeoutMs
  ) {
    next.outcome = {
      ok: false,
      code: EXIT.STUCK_LOADING,
      reason: `instance stuck in '${actualStatus || "provisioning"}' past --loading-timeout-minutes (${Math.round(state.loadingTimeoutMs / 60000)}m)`,
    };
    return next;
  }
  return next;
}

/** Kill paths where trying the next-cheapest offer can plausibly succeed. */
export function isRetryableOutcome(code) {
  return (
    code === EXIT.STUCK_LOADING ||
    code === EXIT.INSTANCE_LOST ||
    code === EXIT.CREATE_FAILED
  );
}

// ---------------------------------------------------------------------------
// Log parsing

/** 'failure' | 'success' | null. Failure wins: a failed step never prints SUCCESS. */
export function detectMarker(logsText) {
  if (typeof logsText !== "string" || logsText.length === 0) return null;
  if (logsText.includes(FAILURE_MARKER)) return "failure";
  if (logsText.includes(SUCCESS_MARKER)) return "success";
  return null;
}

/**
 * Extract the LAST complete certification JSON block from pulled logs (last,
 * because a retried onstart may print more than one) and verify it parses.
 * Returns the raw JSON string or null.
 */
export function extractCertification(logsText) {
  if (typeof logsText !== "string") return null;
  const begin = logsText.lastIndexOf(CERT_BEGIN_MARKER);
  if (begin === -1) return null;
  const end = logsText.indexOf(CERT_END_MARKER, begin);
  if (end === -1) return null;
  const raw = logsText.slice(begin + CERT_BEGIN_MARKER.length, end).trim();
  try {
    JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — log tails can truncate the
    // block mid-JSON; an explicit null (RESULTS_PULL_FAILED upstream) beats
    // writing a corrupt certification.json.
    return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Dry-run plan

/** The complete plan, printable with zero API calls and zero secret material. */
export function buildDryRunPlan(opts) {
  const onstart = buildOnstart(opts);
  const onstartBytes = assertOnstartSize(onstart);
  const payload = buildCreatePayload(opts, onstart);
  return {
    api: {
      base: API_BASE,
      searchEndpoint: "PUT /search/asks/",
      createEndpoint: "PUT /asks/{offer_id}/",
      pollEndpoint: "GET /instances/{instance_id}/",
      logsEndpoint: "PUT /instances/request_logs/{instance_id}/",
      destroyEndpoint: "DELETE /instances/{instance_id}/",
    },
    query: buildOfferQuery(opts),
    clientSideFilters: {
      maxDph: opts.maxDph,
      minReliability: opts.minReliability,
      minInetDown: opts.minInetDown,
      numGpus: opts.numGpus,
    },
    budget: {
      maxDph: opts.maxDph,
      maxAttempts: opts.maxAttempts,
      timeoutMinutes: opts.timeoutMinutes,
      worstCaseUsd: Number(
        (opts.maxDph * opts.maxAttempts * (opts.timeoutMinutes / 60)).toFixed(
          2,
        ),
      ),
    },
    createPayload: {
      ...redactCreatePayload(payload),
      onstart: `<${onstartBytes} bytes, printed below>`,
    },
    poll: {
      intervalSeconds: opts.pollIntervalSeconds,
      timeoutMinutes: opts.timeoutMinutes,
      loadingTimeoutMinutes: opts.loadingTimeoutMinutes,
      terminalStatuses: ["exited", "offline", "unknown"],
      successSignal: SUCCESS_MARKER,
      failureSignal: FAILURE_MARKER,
    },
    cleanup: {
      action: "DESTROY (never stop; stopped instances keep billing disk)",
      retries: 3,
      onFailure: `exit ${EXIT.DESTROY_FAILED} + loud instance-id banner`,
    },
    secrets: {
      [SIGNING_KEY_ENV_VAR]: opts.signingKey
        ? "present (create-env only)"
        : "NOT SET",
      [PUSH_CMD_ENV_VAR]: opts.pushCmd
        ? "present (create-env only)"
        : "not set (cert travels via logs; bundle stays on instance)",
      [API_KEY_ENV_VAR]: opts.apiKey ? "present" : "NOT SET",
    },
    exitCodes: EXIT,
    onstart,
  };
}

// ---------------------------------------------------------------------------
// vast.ai REST client (thin; only main() uses it)

export class VastClient {
  constructor(apiKey, { fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async request(method, apiPath, body) {
    const response = await this.fetch(`${API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const errorCode = parseVastErrorCode(text);
      throw new VastApiError(
        `vast API ${method} ${apiPath} → HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`,
        {
          status: response.status,
          body: text.slice(0, 2000),
          errorCode,
        },
      );
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new VastApiError(
        `vast API ${method} ${apiPath} returned non-JSON`,
        {
          status: response.status,
          body: text.slice(0, 2000),
          cause,
        },
      );
    }
  }

  async searchOffers(query) {
    // PUT with a {q: ...} wrapper is what the live API accepts (vast-python's
    // "new search endpoint" path); select_cols is omitted because the API
    // rejects the CLI's "*" wildcard and the default columns include
    // everything the client-side re-filter reads.
    const result = await this.request("PUT", "/search/asks/", { q: query });
    if (!Array.isArray(result?.offers)) {
      throw new VastApiError("vast search response has no offers array", {
        body: result,
      });
    }
    return result.offers;
  }

  async createInstance(offerId, payload) {
    const result = await this.request("PUT", `/asks/${offerId}/`, payload);
    if (result?.success !== true || typeof result?.new_contract !== "number") {
      throw new VastApiError(`create on offer ${offerId} not accepted`, {
        body: result,
      });
    }
    return result.new_contract;
  }

  async getInstance(instanceId) {
    const result = await this.request("GET", `/instances/${instanceId}/`);
    const instance = result?.instances;
    if (!instance || typeof instance !== "object") {
      throw new VastApiError(`instance ${instanceId} missing from response`, {
        body: result,
      });
    }
    return instance;
  }

  /**
   * Instance logs arrive indirectly: the request_logs call returns a
   * result_url that 404s until vast's agent uploads the tail; poll it briefly.
   */
  async fetchLogs(
    instanceId,
    { tail = 100000, waitMs = 45000, stepMs = 3000 } = {},
  ) {
    const result = await this.request(
      "PUT",
      `/instances/request_logs/${instanceId}/`,
      {
        tail: String(tail),
      },
    );
    const url = result?.result_url;
    if (typeof url !== "string" || url.length === 0) {
      throw new VastApiError(`no result_url for instance ${instanceId} logs`, {
        body: result,
      });
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const response = await this.fetch(url);
      if (response.ok) return await response.text();
      if (Date.now() >= deadline) {
        throw new VastApiError(
          `logs for instance ${instanceId} never became available`,
          {
            status: response.status,
          },
        );
      }
      await delay(stepMs);
    }
  }

  async destroyInstance(instanceId) {
    await this.request("DELETE", `/instances/${instanceId}/`, {});
  }
}

// ---------------------------------------------------------------------------
// Orchestration (network + process boundary; console IS the product here)

/**
 * DESTROY with retries. Returns true when the instance is gone. On total
 * failure prints an unmissable banner with the id — a dangling instance is
 * live billing and a human must kill it in the vast console.
 */
async function destroyWithRetries(
  client,
  instanceId,
  { retries = 3, backoffMs = 5000 } = {},
) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await client.destroyInstance(instanceId);
      console.log(
        `[cert-run] destroyed instance ${instanceId} (attempt ${attempt})`,
      );
      return true;
    } catch (error) {
      // error-policy:J2 context-adding rethrow deferred — retry loop; the
      // final failure surfaces as the banner + EXIT.DESTROY_FAILED below.
      console.error(
        `[cert-run] destroy attempt ${attempt}/${retries} for instance ${instanceId} failed: ${error.message}`,
      );
      if (attempt < retries) await delay(backoffMs * attempt);
    }
  }
  console.error("");
  console.error(
    "################################################################",
  );
  console.error(`##  FAILED TO DESTROY VAST INSTANCE ${instanceId}`);
  console.error("##  IT IS STILL BILLING. Destroy it NOW in the vast console:");
  console.error(
    `##    https://cloud.vast.ai/instances/  (instance id ${instanceId})`,
  );
  console.error(
    `##  or: curl -X DELETE -H "Authorization: Bearer $${API_KEY_ENV_VAR}" ${API_BASE}/instances/${instanceId}/`,
  );
  console.error(
    "################################################################",
  );
  return false;
}

/** One rental attempt against one offer: create → poll → pull → destroy (finally). */
async function runAttempt(client, offer, opts) {
  const onstart = buildOnstart(opts);
  assertOnstartSize(onstart);
  const payload = buildCreatePayload(opts, onstart);

  let instanceId;
  try {
    instanceId = await client.createInstance(offer.id, payload);
  } catch (error) {
    if (error instanceof VastApiError && error.isAuthFailure) throw error;
    console.error(
      `[cert-run] create on offer ${offer.id} failed: ${error.message}`,
    );
    return {
      ok: false,
      code: EXIT.CREATE_FAILED,
      reason: `create failed: ${error.message}`,
      costUsd: 0,
    };
  }
  console.log(
    `[cert-run] created instance ${instanceId} from offer ${offer.id} @ $${offer.dph_total.toFixed(4)}/hr`,
  );

  const startedAt = Date.now();
  const logEveryMs = 60_000;
  let lastLogPull = 0;
  let logsText = "";
  let state = createPollState({
    timeoutMs: opts.timeoutMinutes * 60_000,
    loadingTimeoutMs: opts.loadingTimeoutMinutes * 60_000,
  });

  try {
    while (!state.outcome) {
      await delay(opts.pollIntervalSeconds * 1000);
      const elapsedMs = Date.now() - startedAt;
      let actualStatus = "";
      try {
        const instance = await client.getInstance(instanceId);
        actualStatus =
          typeof instance.actual_status === "string"
            ? instance.actual_status
            : "";
      } catch (error) {
        if (error instanceof VastApiError && error.isAuthFailure) throw error;
        // error-policy:J3 untrusted-input sanitizing — a transient poll
        // failure becomes an explicit "unknown" status, which the reducer
        // debounces and turns into INSTANCE_LOST if it persists.
        console.error(
          `[cert-run] poll failed (treating as unknown): ${error.message}`,
        );
        actualStatus = "unknown";
      }
      let marker = null;
      const shouldPullLogs =
        actualStatus === "running" || actualStatus === "exited"
          ? Date.now() - lastLogPull >= logEveryMs || actualStatus === "exited"
          : false;
      if (shouldPullLogs) {
        lastLogPull = Date.now();
        try {
          logsText = await client.fetchLogs(instanceId);
        } catch (error) {
          if (error instanceof VastApiError && error.isAuthFailure) throw error;
          // error-policy:J7 diagnostics-must-not-kill-the-loop — a missed log
          // tail only delays marker detection by one interval; instance
          // status still drives every hard kill path.
          console.error(
            `[cert-run] log pull failed (will retry): ${error.message}`,
          );
        }
        marker = detectMarker(logsText);
      }
      state = reducePoll(state, { actualStatus, elapsedMs, marker });
      console.log(
        `[cert-run] t+${Math.round(elapsedMs / 1000)}s status=${actualStatus || "provisioning"}${marker ? ` marker=${marker}` : ""}`,
      );
    }

    const elapsedHours = (Date.now() - startedAt) / 3_600_000;
    const costUsd = elapsedHours * offer.dph_total;
    const outcome = { ...state.outcome, costUsd };

    // Final log pull for the artifact directory, success or not — failures
    // need the logs even more than successes do.
    try {
      logsText = await client.fetchLogs(instanceId);
    } catch (error) {
      // error-policy:J6 best-effort teardown — the run outcome is already
      // decided; missing final logs degrade the artifact, not the verdict.
      console.error(`[cert-run] final log pull failed: ${error.message}`);
    }
    fs.mkdirSync(opts.outDir, { recursive: true });
    const logPath = path.join(opts.outDir, `instance-${instanceId}.log`);
    fs.writeFileSync(logPath, logsText);
    console.log(`[cert-run] instance logs → ${logPath}`);

    if (outcome.ok) {
      const cert = extractCertification(logsText);
      if (cert === null) {
        return {
          ok: false,
          code: EXIT.RESULTS_PULL_FAILED,
          reason:
            "run succeeded but no parseable certification JSON in pulled logs",
          costUsd,
        };
      }
      const certPath = path.join(opts.outDir, "certification.json");
      fs.writeFileSync(certPath, `${cert}\n`);
      console.log(`[cert-run] certification → ${certPath}`);
    }
    return outcome;
  } finally {
    const destroyed = await destroyWithRetries(client, instanceId);
    if (!destroyed) {
      // Overrides any other outcome via the flag main() checks: a dangling
      // billed instance is worse than a failed run.
      process.exitCode = EXIT.DESTROY_FAILED;
    }
  }
}

export async function main(argv, env) {
  let opts;
  try {
    opts = parseCliArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[cert-run] ${error.message}\n\n${USAGE}`);
      return EXIT.USAGE;
    }
    throw error;
  }
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }

  if (opts.dryRun) {
    const plan = buildDryRunPlan(opts);
    const { onstart, ...rest } = plan;
    console.log("[cert-run] DRY RUN — no API calls will be made");
    console.log(JSON.stringify(rest, null, 2));
    console.log("\n--- onstart script ---");
    console.log(onstart);
    return EXIT.OK;
  }

  const client = new VastClient(opts.apiKey);
  let offers;
  try {
    offers = await client.searchOffers(buildOfferQuery(opts));
  } catch (error) {
    if (error instanceof VastApiError && error.isAuthFailure) {
      console.error(
        `[cert-run] vast API key rejected (HTTP ${error.status}${error.errorCode ? `, ${error.errorCode}` : ""}) — dead or unscoped ${API_KEY_ENV_VAR}`,
      );
      return EXIT.DEAD_API_KEY;
    }
    throw error;
  }

  const { eligible, rejected } = filterAndSortOffers(offers, opts);
  console.log(
    `[cert-run] ${offers.length} offers from search; ${eligible.length} eligible after client-side re-check (${rejected.length} rejected)`,
  );
  for (const reject of rejected.slice(0, 10)) {
    console.log(`[cert-run]   rejected offer ${reject.id}: ${reject.reason}`);
  }
  if (eligible.length === 0) {
    console.error(
      `[cert-run] no eligible offers (gpu=${opts.gpuName}, dph<=${opts.maxDph}, reliability>${opts.minReliability}, inet_down>${opts.minInetDown}). Raise --max-dph or retry later.`,
    );
    return EXIT.NO_OFFERS;
  }

  const attempts = selectAttemptOffers(eligible, opts);
  let totalCostUsd = 0;
  let lastFailure = null;
  try {
    for (let index = 0; index < attempts.length; index += 1) {
      const offer = attempts[index];
      console.log(
        `[cert-run] attempt ${index + 1}/${attempts.length}: offer ${offer.id} (${offer.gpu_name}, $${offer.dph_total.toFixed(4)}/hr, reliability ${offer.reliabilityResolved})`,
      );
      const outcome = await runAttempt(client, offer, opts);
      totalCostUsd += outcome.costUsd;
      if (outcome.ok) {
        console.log(
          `[cert-run] SUCCESS — certification pulled. Estimated spend this run: $${totalCostUsd.toFixed(3)}`,
        );
        return EXIT.OK;
      }
      lastFailure = outcome;
      console.error(
        `[cert-run] attempt ${index + 1} failed (exit ${outcome.code}): ${outcome.reason}`,
      );
      if (!isRetryableOutcome(outcome.code)) break;
    }
  } catch (error) {
    if (error instanceof VastApiError && error.isAuthFailure) {
      console.error(
        `[cert-run] vast API key rejected mid-run (HTTP ${error.status}${error.errorCode ? `, ${error.errorCode}` : ""})`,
      );
      return EXIT.DEAD_API_KEY;
    }
    throw error;
  } finally {
    console.log(
      `[cert-run] estimated total spend: $${totalCostUsd.toFixed(3)}`,
    );
  }
  if (
    lastFailure &&
    isRetryableOutcome(lastFailure.code) &&
    attempts.length >= opts.maxAttempts
  ) {
    console.error(
      `[cert-run] budget guard: --max-attempts (${opts.maxAttempts}) exhausted`,
    );
    return EXIT.BUDGET_EXCEEDED;
  }
  return lastFailure ? lastFailure.code : EXIT.BUDGET_EXCEEDED;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      // A failed destroy (set via process.exitCode in the finally) must not
      // be overwritten by a happier code from the run itself.
      if (process.exitCode !== EXIT.DESTROY_FAILED) process.exitCode = code;
    },
    (error) => {
      console.error(`[cert-run] fatal: ${error.stack ?? error.message}`);
      process.exitCode = 1;
    },
  );
}
