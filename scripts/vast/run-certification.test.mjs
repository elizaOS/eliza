/**
 * Unit tests for the pure pieces of the vast.ai certification runner: offer
 * filtering/sorting, onstart assembly + the 16 KB vast cap, the poll state
 * machine's kill paths, budget guards, CLI parsing, log-marker/certification
 * extraction, and dry-run secret redaction. No network, no vast account —
 * everything here is a pure function imported from run-certification.mjs
 * (the real-instance acceptance run is owner-gated on VAST_API_KEY).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  API_KEY_ENV_VAR,
  assertOnstartSize,
  buildCreatePayload,
  buildDryRunPlan,
  buildOfferQuery,
  buildOnstart,
  CERT_BEGIN_MARKER,
  CERT_END_MARKER,
  createPollState,
  detectMarker,
  EXIT,
  extractCertification,
  FAILURE_MARKER,
  filterAndSortOffers,
  isRetryableOutcome,
  ONSTART_MAX_BYTES,
  PUSH_CMD_ENV_VAR,
  parseCliArgs,
  redactCreatePayload,
  reducePoll,
  SIGNING_KEY_ENV_VAR,
  SUCCESS_MARKER,
  selectAttemptOffers,
  UsageError,
} from "./run-certification.mjs";

const SHA = "a".repeat(40);

function baseOpts(overrides = {}) {
  return parseCliArgs(["--sha", SHA, "--dry-run"], {
    [SIGNING_KEY_ENV_VAR]: undefined,
    ...overrides.env,
  });
}

function offer(overrides = {}) {
  return {
    id: 1,
    dph_total: 0.35,
    reliability2: 0.995,
    inet_down: 900,
    num_gpus: 1,
    gpu_name: "RTX 4090",
    ...overrides,
  };
}

describe("buildOfferQuery", () => {
  it("translates underscore GPU names and pins the acceptance filters", () => {
    const query = buildOfferQuery(baseOpts());
    assert.equal(query.gpu_name.eq, "RTX 4090");
    assert.equal(query.num_gpus.eq, 1);
    assert.equal(query.verified.eq, true);
    assert.equal(query.rentable.eq, true);
    assert.equal(query.reliability2.gt, 0.98);
    assert.equal(query.inet_down.gt, 500);
    assert.deepEqual(query.order, [["dph_total", "asc"]]);
    assert.equal(query.type, "ask");
  });
});

describe("filterAndSortOffers", () => {
  it("sorts eligible offers cheapest-first with reliability tie-break", () => {
    const { eligible } = filterAndSortOffers(
      [
        offer({ id: 1, dph_total: 0.4 }),
        offer({ id: 2, dph_total: 0.3, reliability2: 0.99 }),
        offer({ id: 3, dph_total: 0.3, reliability2: 0.999 }),
      ],
      baseOpts(),
    );
    assert.deepEqual(
      eligible.map((entry) => entry.id),
      [3, 2, 1],
    );
  });

  it("rejects offers over --max-dph with a reason (budget guard)", () => {
    const { eligible, rejected } = filterAndSortOffers(
      [offer({ id: 7, dph_total: 0.99 })],
      baseOpts(),
    );
    assert.equal(eligible.length, 0);
    assert.equal(rejected[0].id, 7);
    assert.match(rejected[0].reason, /--max-dph/);
  });

  it("re-checks reliability, inet_down and num_gpus client-side", () => {
    const { eligible, rejected } = filterAndSortOffers(
      [
        offer({ id: 1, reliability2: 0.9 }),
        offer({ id: 2, inet_down: 100 }),
        offer({ id: 3, num_gpus: 4 }),
        offer({ id: 4 }),
      ],
      baseOpts(),
    );
    assert.deepEqual(
      eligible.map((entry) => entry.id),
      [4],
    );
    assert.equal(rejected.length, 3);
  });

  it("falls back to legacy `reliability` and rejects offers missing both", () => {
    const { eligible, rejected } = filterAndSortOffers(
      [
        offer({ id: 1, reliability2: undefined, reliability: 0.999 }),
        offer({ id: 2, reliability2: undefined, reliability: undefined }),
      ],
      baseOpts(),
    );
    assert.deepEqual(
      eligible.map((entry) => entry.id),
      [1],
    );
    assert.match(rejected[0].reason, /missing reliability/);
  });

  it("never assumes compliance for offers missing dph_total or id", () => {
    const { eligible } = filterAndSortOffers(
      [offer({ id: undefined }), offer({ dph_total: undefined })],
      baseOpts(),
    );
    assert.equal(eligible.length, 0);
  });
});

describe("selectAttemptOffers", () => {
  it("caps attempts at --max-attempts, cheapest-first", () => {
    const { eligible } = filterAndSortOffers(
      [1, 2, 3, 4, 5].map((id) => offer({ id, dph_total: id / 10 })),
      baseOpts(),
    );
    const attempts = selectAttemptOffers(eligible, { maxAttempts: 2 });
    assert.deepEqual(
      attempts.map((entry) => entry.id),
      [1, 2],
    );
  });
});

describe("buildOnstart", () => {
  it("clones the exact sha and runs the certification chain in order", () => {
    const onstart = buildOnstart(baseOpts());
    const cloneIndex = onstart.indexOf(`git fetch --depth 1 origin ${SHA}`);
    const installIndex = onstart.indexOf("bun run install:light");
    const bundleIndex = onstart.indexOf("bundle:create -- --tier full");
    const rollupIndex = onstart.indexOf("certify:rollup");
    const signIndex = onstart.indexOf("certify:sign");
    assert.ok(
      cloneIndex > -1 && installIndex > cloneIndex,
      "clone then install",
    );
    assert.ok(bundleIndex > installIndex, "bundle after install");
    assert.ok(rollupIndex > bundleIndex, "rollup after bundle");
    assert.ok(signIndex > rollupIndex, "sign after rollup");
    assert.ok(onstart.includes(SUCCESS_MARKER));
    assert.ok(onstart.includes(CERT_BEGIN_MARKER));
    assert.ok(onstart.includes("ELIZA_EVIDENCE_RUNNER=vast"));
  });

  it("never embeds secret material in the onstart text", () => {
    const opts = {
      ...baseOpts(),
      signingKey: "-----BEGIN PRIVATE KEY-----SECRETSECRET",
      pushCmd: "aws s3 cp --secret-token hunter2",
      apiKey: "vast-key-hunter3",
    };
    const onstart = buildOnstart(opts);
    assert.ok(!onstart.includes("SECRETSECRET"));
    assert.ok(!onstart.includes("hunter2"));
    assert.ok(!onstart.includes("hunter3"));
    // The push command is referenced by env var NAME only.
    assert.ok(onstart.includes(`\${${PUSH_CMD_ENV_VAR}:-}`));
  });

  it("stays comfortably under the 16 KB vast cap with defaults", () => {
    const bytes = assertOnstartSize(buildOnstart(baseOpts()));
    assert.ok(
      bytes < ONSTART_MAX_BYTES / 4,
      `expected small onstart, got ${bytes} bytes`,
    );
  });
});

describe("assertOnstartSize", () => {
  it("throws UsageError past 16 KB (multi-byte aware)", () => {
    assert.throws(
      () => assertOnstartSize("é".repeat(ONSTART_MAX_BYTES / 2 + 1)),
      UsageError,
    );
    assert.throws(
      () =>
        assertOnstartSize(
          buildOnstart({ ...baseOpts(), reviewerId: "x".repeat(17000) }),
        ),
      /16384/,
    );
  });

  it("accepts exactly 16 KB", () => {
    assert.equal(
      assertOnstartSize("x".repeat(ONSTART_MAX_BYTES)),
      ONSTART_MAX_BYTES,
    );
  });
});

describe("buildCreatePayload / redactCreatePayload", () => {
  it("injects signing key and push cmd via env only, destroy-safe defaults", () => {
    const opts = { ...baseOpts(), signingKey: "PEMPEM", pushCmd: "push it" };
    const payload = buildCreatePayload(opts, "onstart");
    assert.equal(payload.env[SIGNING_KEY_ENV_VAR], "PEMPEM");
    assert.equal(payload.env[PUSH_CMD_ENV_VAR], "push it");
    assert.equal(payload.env.ELIZA_EVIDENCE_RUNNER, "vast");
    assert.equal(payload.client_id, "me");
    assert.equal(payload.image, "ghcr.io/elizaos/certification-gpu:latest");
    assert.equal(payload.label, `eliza-certification-${SHA.slice(0, 12)}`);
  });

  it("redacts every env value, keeps the key names visible", () => {
    const payload = buildCreatePayload(
      { ...baseOpts(), signingKey: "PEMPEM", pushCmd: "s3 cp secret" },
      "onstart",
    );
    const redacted = redactCreatePayload(payload);
    assert.deepEqual(
      Object.values(redacted.env),
      Object.keys(payload.env).map(() => "<redacted>"),
    );
    assert.ok(JSON.stringify(redacted).includes(SIGNING_KEY_ENV_VAR));
    assert.ok(!JSON.stringify(redacted).includes("PEMPEM"));
  });
});

describe("poll state machine", () => {
  const config = { timeoutMs: 60 * 60_000, loadingTimeoutMs: 10 * 60_000 };

  function run(snapshots, stateConfig = config) {
    let state = createPollState(stateConfig);
    for (const snapshot of snapshots) {
      state = reducePoll(state, { marker: null, ...snapshot });
      if (state.outcome) return state;
    }
    return state;
  }

  it("happy path: loading → running → success marker", () => {
    const state = run([
      { actualStatus: "loading", elapsedMs: 60_000 },
      { actualStatus: "running", elapsedMs: 300_000 },
      { actualStatus: "running", elapsedMs: 900_000, marker: "success" },
    ]);
    assert.deepEqual(state.outcome, { ok: true });
  });

  it("failure marker → ONSTART_FAILED even while still running", () => {
    const state = run([
      { actualStatus: "running", elapsedMs: 300_000, marker: "failure" },
    ]);
    assert.equal(state.outcome.ok, false);
    assert.equal(state.outcome.code, EXIT.ONSTART_FAILED);
  });

  it("exited without success marker → ONSTART_FAILED", () => {
    const state = run([
      { actualStatus: "running", elapsedMs: 300_000 },
      { actualStatus: "exited", elapsedMs: 600_000 },
    ]);
    assert.equal(state.outcome.code, EXIT.ONSTART_FAILED);
    assert.match(state.outcome.reason, /without the success marker/);
  });

  it("exited WITH success marker in the same tick is a success", () => {
    const state = run([
      { actualStatus: "exited", elapsedMs: 600_000, marker: "success" },
    ]);
    assert.deepEqual(state.outcome, { ok: true });
  });

  it("stuck in loading past the loading timeout → STUCK_LOADING", () => {
    const state = run([
      { actualStatus: "loading", elapsedMs: 60_000 },
      { actualStatus: "loading", elapsedMs: 11 * 60_000 },
    ]);
    assert.equal(state.outcome.code, EXIT.STUCK_LOADING);
  });

  it("blank/provisioning status counts as loading for the stuck check", () => {
    const state = run([{ actualStatus: "", elapsedMs: 11 * 60_000 }]);
    assert.equal(state.outcome.code, EXIT.STUCK_LOADING);
  });

  it("loading timeout does NOT fire once the instance has been running", () => {
    const state = run([
      { actualStatus: "running", elapsedMs: 60_000 },
      { actualStatus: "loading", elapsedMs: 11 * 60_000 },
    ]);
    assert.equal(state.outcome, null);
  });

  it("offline/unknown are debounced, then INSTANCE_LOST", () => {
    const state = run([
      { actualStatus: "running", elapsedMs: 60_000 },
      { actualStatus: "offline", elapsedMs: 120_000 },
      { actualStatus: "unknown", elapsedMs: 180_000 },
      { actualStatus: "offline", elapsedMs: 240_000 },
    ]);
    assert.equal(state.outcome.code, EXIT.INSTANCE_LOST);
  });

  it("a healthy poll resets the offline debounce", () => {
    const state = run([
      { actualStatus: "offline", elapsedMs: 60_000 },
      { actualStatus: "offline", elapsedMs: 120_000 },
      { actualStatus: "running", elapsedMs: 180_000 },
      { actualStatus: "offline", elapsedMs: 240_000 },
      { actualStatus: "offline", elapsedMs: 300_000 },
    ]);
    assert.equal(state.outcome, null);
    assert.equal(state.consecutiveLost, 2);
  });

  it("hard wall-clock timeout → RUN_TIMEOUT", () => {
    const state = run([{ actualStatus: "running", elapsedMs: 61 * 60_000 }]);
    assert.equal(state.outcome.code, EXIT.RUN_TIMEOUT);
  });

  it("terminal state is sticky", () => {
    let state = run([{ actualStatus: "running", elapsedMs: 61 * 60_000 }]);
    state = reducePoll(state, {
      actualStatus: "running",
      elapsedMs: 62 * 60_000,
      marker: "success",
    });
    assert.equal(state.outcome.code, EXIT.RUN_TIMEOUT);
  });
});

describe("isRetryableOutcome", () => {
  it("retries only host-side failures, never chain failures or timeouts", () => {
    assert.ok(isRetryableOutcome(EXIT.STUCK_LOADING));
    assert.ok(isRetryableOutcome(EXIT.INSTANCE_LOST));
    assert.ok(isRetryableOutcome(EXIT.CREATE_FAILED));
    assert.ok(!isRetryableOutcome(EXIT.ONSTART_FAILED));
    assert.ok(!isRetryableOutcome(EXIT.RUN_TIMEOUT));
    assert.ok(!isRetryableOutcome(EXIT.DEAD_API_KEY));
  });
});

describe("VastApiError auth classification", () => {
  it("maps vast's 404 + auth_error body to a dead key (live-API behavior)", async () => {
    const { parseVastErrorCode, VastApiError } = await import(
      "./run-certification.mjs"
    );
    // Verified against the live API: a dead key answers HTTP 404 with
    // {"success":false,"error":"auth_error","msg":"Invalid user key"}.
    const body =
      '{"success":false,"error":"auth_error","msg":"Invalid user key"}';
    assert.equal(parseVastErrorCode(body), "auth_error");
    const authByCode = new VastApiError("x", {
      status: 404,
      errorCode: "auth_error",
    });
    assert.ok(authByCode.isAuthFailure);
    const authByStatus = new VastApiError("x", { status: 401 });
    assert.ok(authByStatus.isAuthFailure);
    const plain404 = new VastApiError("x", { status: 404 });
    assert.ok(!plain404.isAuthFailure);
  });

  it("returns undefined for HTML error pages, never throws", async () => {
    const { parseVastErrorCode } = await import("./run-certification.mjs");
    assert.equal(parseVastErrorCode("<html>404</html>"), undefined);
    assert.equal(parseVastErrorCode('{"msg":"no error field"}'), undefined);
    assert.equal(parseVastErrorCode(undefined), undefined);
  });
});

describe("detectMarker / extractCertification", () => {
  it("failure marker wins over a later success marker", () => {
    assert.equal(
      detectMarker(`${FAILURE_MARKER}: rollup\n${SUCCESS_MARKER}\n`),
      "failure",
    );
    assert.equal(detectMarker(`all good\n${SUCCESS_MARKER}\n`), "success");
    assert.equal(detectMarker("still going"), null);
    assert.equal(detectMarker(""), null);
    assert.equal(detectMarker(undefined), null);
  });

  it("extracts the LAST complete certification block and validates JSON", () => {
    const first = JSON.stringify({ commit: "old" });
    const second = JSON.stringify({ commit: SHA, verdicts: [] });
    const logs = [
      CERT_BEGIN_MARKER,
      first,
      CERT_END_MARKER,
      "retry noise",
      CERT_BEGIN_MARKER,
      second,
      CERT_END_MARKER,
      SUCCESS_MARKER,
    ].join("\n");
    assert.equal(extractCertification(logs), second);
  });

  it("returns null for truncated or unparseable blocks (never corrupt output)", () => {
    assert.equal(extractCertification(`${CERT_BEGIN_MARKER}\n{"a": 1`), null);
    assert.equal(
      extractCertification(
        `${CERT_BEGIN_MARKER}\n{"a": tru\n${CERT_END_MARKER}`,
      ),
      null,
    );
    assert.equal(extractCertification("no markers"), null);
  });
});

describe("parseCliArgs", () => {
  it("requires --sha as hex and validates --tier", () => {
    assert.throws(() => parseCliArgs(["--dry-run"], {}), /--sha is required/);
    assert.throws(
      () => parseCliArgs(["--sha", "not-hex!", "--dry-run"], {}),
      /--sha/,
    );
    assert.throws(
      () => parseCliArgs(["--sha", SHA, "--tier", "mega", "--dry-run"], {}),
      /--tier must be one of/,
    );
  });

  it("requires api + signing keys for real runs, but not for --dry-run", () => {
    assert.throws(
      () => parseCliArgs(["--sha", SHA], {}),
      new RegExp(API_KEY_ENV_VAR),
    );
    assert.throws(
      () => parseCliArgs(["--sha", SHA], { [API_KEY_ENV_VAR]: "k" }),
      new RegExp(SIGNING_KEY_ENV_VAR),
    );
    const opts = parseCliArgs(["--sha", SHA, "--dry-run"], {});
    assert.equal(opts.dryRun, true);
  });

  it("parses budget guards and rejects non-positive values", () => {
    const opts = parseCliArgs(
      [
        "--sha",
        SHA,
        "--dry-run",
        "--max-dph",
        "0.45",
        "--max-attempts",
        "2",
        "--timeout-minutes",
        "90",
      ],
      {},
    );
    assert.equal(opts.maxDph, 0.45);
    assert.equal(opts.maxAttempts, 2);
    assert.equal(opts.timeoutMinutes, 90);
    assert.throws(
      () =>
        parseCliArgs(["--sha", SHA, "--dry-run", "--max-attempts", "0"], {}),
      /--max-attempts/,
    );
    assert.throws(
      () =>
        parseCliArgs(["--sha", SHA, "--dry-run", "--max-dph", "banana"], {}),
      /--max-dph/,
    );
    assert.throws(
      () => parseCliArgs(["--sha", SHA, "--dry-run", "--unknown"], {}),
      /unknown argument/,
    );
  });

  it("reads keys and push cmd from the environment", () => {
    const opts = parseCliArgs(["--sha", SHA], {
      [API_KEY_ENV_VAR]: "api-key",
      [SIGNING_KEY_ENV_VAR]: "pem",
      [PUSH_CMD_ENV_VAR]: "rclone copy",
    });
    assert.equal(opts.apiKey, "api-key");
    assert.equal(opts.signingKey, "pem");
    assert.equal(opts.pushCmd, "rclone copy");
  });
});

describe("buildDryRunPlan", () => {
  it("summarizes budget worst-case and never leaks secret values", () => {
    const opts = parseCliArgs(
      [
        "--sha",
        SHA,
        "--dry-run",
        "--max-dph",
        "0.5",
        "--max-attempts",
        "2",
        "--timeout-minutes",
        "60",
      ],
      {
        [SIGNING_KEY_ENV_VAR]: "-----BEGIN PRIVATE KEY-----LEAKME",
        [API_KEY_ENV_VAR]: "vast-LEAKME",
        [PUSH_CMD_ENV_VAR]: "s3 cp --token LEAKME",
      },
    );
    const plan = buildDryRunPlan(opts);
    assert.equal(plan.budget.worstCaseUsd, 1);
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes("LEAKME"));
    assert.equal(
      plan.secrets[SIGNING_KEY_ENV_VAR],
      "present (create-env only)",
    );
    assert.ok(plan.onstart.includes(SHA));
    assert.equal(plan.cleanup.retries, 3);
  });
});
