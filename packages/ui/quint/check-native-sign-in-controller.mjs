/** Require the named scenarios that run the actual controller against a native port. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const ui = path.join(root, "packages/ui");
const controllerNames = [
  "shared native sign-in owner accepts a late positive readiness result only for its current unchanged chooser",
  "shared native sign-in owner rejects late readiness after owner changes",
  "shared native sign-in owner rejects late readiness after operation changes",
  "shared native sign-in owner rejects late readiness after method changes",
  "shared native sign-in owner cancels a held native call promptly and ignores its late success",
  "shared native sign-in owner requires acknowledged native retirement before dispatching another method",
  "shared native sign-in owner retries account activation from the same authenticated outcome without another sign-in",
  "shared native sign-in owner joins a retained completion to a held native request through account activation",
  "shared native sign-in owner does not cancel a successful host transaction when completion removes its view",
  "shared native sign-in owner joins the host operation and cannot publish when that operation is cancelled",
  "native retained completion correlation rejects the cancelled controller's retained completion after closing and reopening",
  "native retained completion correlation accepts only this dispatched request, keeping native and credential identities",
  "canonical broker completion teardown does not cancel the authenticated native attempt when broker publication unmounts the view",
  "native cancellation request correlation does not cancel another request when a readiness-only chooser closes",
  "native cancellation request correlation does not cancel native while an aborted host operation is still awaiting admission",
  "native cancellation request correlation keeps a newer native request when the old teardown reaches native late",
];

const suites = {
  NativeSignInController: {
    file: "src/android-cloud/__e2e__/native-cloud-sign-in-controller.test.ts",
    names: controllerNames,
  },
  NativeSignInResend: {
    file: "src/android-cloud/__e2e__/native-cloud-sign-in-resend.test.ts",
    names: [
      "native sign-in resend ownership accepts verification for the displayed code after a rejected resend",
      "native sign-in resend ownership correlates a retained verification to the admitted displayed attempt",
      "native sign-in resend ownership retires both candidates when the resend is rejected and leaves no usable code",
      "native sign-in resend ownership retires both candidates when the resend is admitted and leaves no usable code",
      "native sign-in resend ownership retires both candidates before a held resend reply can publish",
      "native sign-in resend ownership retries only the unacknowledged scope and holds the owner until it settles",
    ],
  },
};
const model = path.basename(process.argv[2] ?? "", ".qnt");
const suite = suites[model];
assert(suite, `Unknown native sign-in model ${model}`);
const { file, names } = suite;

assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(ui, "quint", `${model}.qnt`),
);
const output = testOutputPath("quint-native-sign-in-controller");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "conformance-"));
const report = path.join(directory, "vitest.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    file,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: ui,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
    },
    stdio: "inherit",
  },
);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  "Native sign-in controller implementation failed",
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(ui, file),
  names,
);
console.log(
  `Native sign-in controller passed ${checks.length} checks. Report ${report}`,
);
