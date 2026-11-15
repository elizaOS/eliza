/** Execute Quint traces through the production lifecycle with native boundary ports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requested = process.argv[2] && path.resolve(process.argv[2]);
const models = new Map([
  ["MobileDeepLinkReceipt", 25],
  ["MobileDeepLinkDiscovery", 20],
]);
function run(binary, args) {
  const child = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.signal) process.kill(process.pid, child.signal);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  return child.stdout;
}
const outputRoot = testOutputPath("quint-mobile-receipts");
await mkdir(outputRoot, { recursive: true });
const require = createRequire(import.meta.url);
const quint = path.join(
  path.dirname(require.resolve("@informalsystems/quint/package.json")),
  "dist/src/cli.js",
);
let checked = 0;
for (const [model, maxSteps] of models) {
  const spec = path.join(root, "packages/app/quint", `${model}.qnt`);
  if (requested && requested !== spec) continue;
  const output = await mkdtemp(path.join(outputRoot, `${model}-`));
  run(process.execPath, [
    quint,
    "run",
    spec,
    "--backend=typescript",
    "--seed=20261107",
    `--max-steps=${maxSteps}`,
    "--max-samples=128",
    "--n-traces=128",
    "--invariant=invariant",
    `--out-itf=${path.join(output, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ]);
  const traces = (await readdir(output))
    .filter((name) => /^trace-\d+\.itf\.json$/.test(name))
    .map((name) => path.join(output, name));
  assert.equal(traces.length, 128);
  const boundary = path.join(output, "boundary.ts");
  await writeFile(
    boundary,
    `
export const App = {
  addListener(event, callback) {
    if (event === "appUrlOpen") globalThis.__mobileFixture.legacy = callback;
    return Promise.resolve({ remove: async () => {} });
  },
  getLaunchUrl() {
    const host = globalThis.__mobileFixture;
    return host.manualLaunch
      ? new Promise((resolve, reject) => host.launchRequests.push({ resolve, reject }))
      : Promise.resolve({ url: host.launch });
  },
  minimizeApp: async () => {},
};
export const Keyboard = { addListener() {} };
export const KeyboardResize = { None: "none" };
export const APP_PAUSE_EVENT = "pause";
export const APP_RESUME_EVENT = "resume";
export const NETWORK_STATUS_CHANGE_EVENT = "network";
export const dispatchAppEvent = () => {};
export const dispatchBackIntent = () => false;
export const initializeIosKeyboardAccessoryBar = async () => {};
export const isStandalonePwa = () => false;
`,
  );
  const build = path.join(output, "build.ts");
  await writeFile(
    build,
    `
const result = await Bun.build({
  entrypoints: [${JSON.stringify(path.join(root, "packages/app/quint/mobile-deep-link-fixture.ts"))}],
  outdir: ${JSON.stringify(output)},
  naming: "fixture.js",
  target: "bun",
  plugins: [{
    name: "native-boundary",
    setup(build) {
      build.onResolve({ filter: /^(@capacitor\\/|@elizaos\\/ui$)/ }, () => ({
        path: ${JSON.stringify(boundary)},
      }));
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, "Fixture build failed");
`,
  );
  run("bun", [build]);
  const result = run("bun", [
    path.join(output, "fixture.js"),
    model,
    ...traces,
  ]);
  await writeFile(path.join(output, "result.log"), result);
  console.log(result.trim());
  checked += 1;
}
assert(checked > 0, `No mobile model matches ${requested}`);
