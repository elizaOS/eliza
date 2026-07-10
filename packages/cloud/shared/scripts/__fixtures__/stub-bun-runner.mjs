// Scripted stand-in for `bun` used by scripts/run-bun-tests.e2e.test.ts.
//
// The wrapper (scripts/run-bun-tests.mjs) spawns it via the ELIZA_BUN_TEST_BIN
// seam exactly like the real bun binary: argv is ["test", ...args]. The stub
// never runs any test files — it emits realistic `bun test` output (including
// the verbatim #15785 panic signature) and exits with the corresponding code,
// so the wrapper's classification/retry/capture pipeline is exercised through
// real process spawns on any platform.
//
// Env contract:
//   STUB_STATE_DIR         (required) directory for the attempt counter and
//                          the invocation log (invocations.jsonl — one JSON
//                          line per spawn: { argv }).
//   STUB_QUARANTINE_PLAN   JSON array of per-attempt behaviors for quarantine
//                          invocations, e.g. ["crash","pass"]. Attempt N uses
//                          plan[N-1]; past the end the last entry repeats.
//                          Behaviors: "pass" | "fail" | "crash" |
//                          "crash-silent" | "hang". Default: ["pass"].
//   STUB_MAIN_MODE         "pass" (default) or "fail" — behavior for main-pass
//                          invocations (identified by a --path-ignore-patterns=
//                          arg).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const stateDir = process.env.STUB_STATE_DIR;
if (!stateDir) {
  console.error("[stub-bun-runner] STUB_STATE_DIR is required");
  process.exit(64);
}
mkdirSync(stateDir, { recursive: true });

const argv = process.argv.slice(2);
appendFileSync(path.join(stateDir, "invocations.jsonl"), `${JSON.stringify({ argv })}\n`);

// The real #15785 output tail (run 29041377960, develop@03f8dcdcf9d), verbatim
// modulo the truncated bun.report token.
const PANIC_OUTPUT = `bun test v1.4.0-canary.1 (7dd427e7a)

src\\lib\\services\\tenant-db\\tenant-db-placement-claimer.test.ts:
(fail) tenant DB durable placement claimer > (unnamed) [6147.35ms]
  ^ a beforeEach/afterEach hook timed out for this test.
panic(main thread): Illegal instruction at address 0x7FF6B271CDB0
oh no: Bun has crashed. This indicates a bug in Bun, not your code.

To send a redacted crash report to Bun's team,
please file a GitHub issue using the link below:

 https://bun.report/1.4.0/w_2fc865b3gHuhooCg7m3rD
`;

const PASS_OUTPUT = `bun test v1.4.0-canary.1 (7dd427e7a)

 1 pass
 0 fail
 6 expect() calls
Ran 1 test across 1 file. [49.00ms]
`;

const FAIL_OUTPUT = `bun test v1.4.0-canary.1 (7dd427e7a)

src\\lib\\services\\tenant-db\\tenant-db-placement-claimer.test.ts:
(fail) tenant DB durable placement claimer > provisionForApp retry reuses the same real placement without claiming a second slot [12.00ms]

 0 pass
 1 fail
 2 expect() calls
Ran 1 test across 1 file. [61.00ms]
`;

function act(behavior) {
  switch (behavior) {
    case "pass":
      process.stdout.write(PASS_OUTPUT);
      process.exit(0);
      break;
    case "fail":
      process.stdout.write(FAIL_OUTPUT);
      process.exit(1);
      break;
    case "crash":
      process.stderr.write(PANIC_OUTPUT);
      process.exit(3);
      break;
    case "crash-silent":
      // Process death without any marker or summary — exercises the
      // exit-code-only branch of the classifier.
      process.stdout.write("bun test v1.4.0-canary.1 (7dd427e7a)\n");
      process.exit(3);
      break;
    case "hang":
      process.stdout.write("bun test v1.4.0-canary.1 (7dd427e7a)\n");
      // Stay alive until the wrapper's watchdog kills the process tree.
      setInterval(() => {}, 1_000);
      break;
    default:
      console.error(`[stub-bun-runner] unknown behavior ${JSON.stringify(behavior)}`);
      process.exit(64);
  }
}

const isMainPass = argv.some((arg) => arg.startsWith("--path-ignore-patterns="));
if (isMainPass) {
  act(process.env.STUB_MAIN_MODE === "fail" ? "fail" : "pass");
} else {
  const plan = JSON.parse(process.env.STUB_QUARANTINE_PLAN ?? '["pass"]');
  const counterFile = path.join(stateDir, "quarantine-attempts.txt");
  let attempt = existsSync(counterFile)
    ? Number.parseInt(readFileSync(counterFile, "utf8"), 10) || 0
    : 0;
  attempt += 1;
  writeFileSync(counterFile, String(attempt));
  act(plan[Math.min(attempt, plan.length) - 1]);
}
