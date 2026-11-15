/** Exact controller/plane and complete React view conformance over controlled ports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "plugins/plugin-maps/quint/MapsObservation.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("./maps-observation-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-maps-observation");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
function run(name, command, cwd = root) {
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "180000",
      "--",
      ...command,
    ],
    {
      cwd,
      env: {
        ...process.env,
        CORE_MAP_PLANE_SOURCE: path.join(
          root,
          "plugins/plugin-maps/src/client/map-plane.ts",
        ),
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const log = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  writeFileSync(path.join(directory, `${name}.log`), log);
  if (child.error) throw child.error;
  assert.equal(child.signal, null, `${name}: interrupted conformance`);
  assert.equal(
    child.status,
    0,
    `${name}: implementation failed; see ${directory}`,
  );
  return log;
}
const pattern = `^(?:${manifest.nodeRequired.map((name) => RegExp.escape(name)).join("|")})$`;
const nodeLog = run("node", [
  process.execPath,
  "--test",
  "--experimental-transform-types",
  "--test-reporter=tap",
  "--test-name-pattern",
  pattern,
  ...manifest.nodeFiles,
]);
const observed = [...nodeLog.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
assert.equal(
  new Set(observed).size,
  observed.length,
  "Duplicate Node conformance identity",
);
assert.deepEqual(
  [...observed].sort(),
  [...manifest.nodeRequired].sort(),
  "Node conformance identities changed",
);
for (const receipt of [
  `# tests ${manifest.nodeRequired.length}`,
  `# pass ${manifest.nodeRequired.length}`,
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
])
  assert(nodeLog.split(/\r?\n/).includes(receipt), `${receipt}: ${directory}`);
const viewReport = path.join(directory, "view.json");
run(
  "view",
  [
    process.execPath,
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    "test/maps-screen-view.test.tsx",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${viewReport}`,
  ],
  path.join(root, "plugins/plugin-maps"),
);
const views = requireVitestConformance(
  JSON.parse(readFileSync(viewReport, "utf8")),
  path.join(root, manifest.viewFile),
  manifest.viewRequired,
);
const sources = Object.fromEntries(
  [
    ...new Set([model, model.replace(".qnt", ".cases.json"), ...cases.sources]),
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, nodeCases: observed, viewCases: views, sources, limits: "Controlled provider/GPS/map ports; real shared controller and React component. No live provider, physical GPS, real telephone call or native host forwarding claim." }, null, 2)}\n`,
);
console.log(
  `Maps observation conformance passed ${observed.length} exact Node and ${views.length} complete React view checks: ${directory}`,
);
