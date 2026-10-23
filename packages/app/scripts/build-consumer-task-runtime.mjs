import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportCommittedSources } from "./lib/committed-source.mjs";

/** @param {Uint8Array} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Upstream source trees that contain the task runtime, guidance and shared UI.
const SOURCE_PATHS = [
  "packages/agent/src",
  "packages/core/src",
  "plugins/plugin-browser/src",
  "plugins/plugin-google-workspace/src",
  "packages/ui/src/voice",
  "packages/ui/src/components/chat/TaskChoice.tsx",
  "packages/os/browser/src",
];

/** @param {string} file */
const readProvenance = (file) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;

/** Return the recorded bundle provenance when every requested output was built
 * by this builder from the same commit and its bytes are unchanged.
 * @param {string} output
 * @param {{schemaVersion:number, sourceCommit:string, builderSha256:string}} spec
 * @param {string|undefined} browserSource
 * @param {string|undefined} commandSource
 */
function reusableOutput(output, spec, browserSource, commandSource) {
  /** @param {any} record */
  const matches = (record) =>
    record?.schemaVersion === spec.schemaVersion &&
    record.sourceCommit === spec.sourceCommit &&
    record.builderSha256 === spec.builderSha256;
  /** @param {string} file @param {string} digest */
  const unchanged = (file, digest) =>
    fs.existsSync(file) && hash(fs.readFileSync(file)) === digest;
  const bundle = readProvenance(`${output}.json`);
  if (!matches(bundle) || !unchanged(output, bundle.bundleSha256)) return;
  if (browserSource) {
    const browser = readProvenance(path.join(browserSource, "provenance.json"));
    if (
      !matches(browser) ||
      Object.entries(browser.files).some(
        ([name, digest]) => !unchanged(path.join(browserSource, name), digest),
      )
    )
      return;
  }
  if (commandSource) {
    const command = readProvenance(path.join(commandSource, "provenance.json"));
    if (
      !matches(command) ||
      !unchanged(
        path.join(commandSource, "command-handler.mjs"),
        command.bundleSha256,
      )
    )
      return;
  }
  return bundle;
}

/** Bundle the shared task runtime from immutable Git source; no overlays.
 * Reuses existing output when its provenance records the same source commit
 * and builder and the recorded hashes still match the files.
 * @param {string} output
 * @param {{sourceRoot:string, sourceCommit:string, browserSource?:string, commandSource?:string}} options
 */
export function buildTaskRuntime(
  output,
  { sourceRoot, sourceCommit, browserSource, commandSource },
) {
  const spec = {
    schemaVersion: 2,
    sourceCommit,
    builderSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  };
  const reused = reusableOutput(output, spec, browserSource, commandSource);
  if (reused) return reused;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-task-build-"));
  try {
    exportCommittedSources(sourceRoot, sourceCommit, temporary, SOURCE_PATHS);
    // Resolve the layout from the exported commit, including older reviewed sources.
    const interactionSources = Object.fromEntries(
      ["sessions", "profiles", "profile-catalog"].map((name) => {
        const current = `messaging/interaction-${name}`;
        const legacy = `messaging/interactions/${name}`;
        return [
          name,
          fs.existsSync(path.join(temporary, `packages/core/src/${current}.ts`))
            ? current
            : legacy,
        ];
      }),
    );
    // This isolated consumer contains only the task runtime. Its local barrel
    // resolves public imports to the same committed implementations without
    // pulling the full agent kernel or unrelated workspace dependencies.
    fs.writeFileSync(
      path.join(temporary, "task-core.ts"),
      [
        "errors",
        "messaging/interactive-task",
        ...Object.values(interactionSources),
        "messaging/task-widgets",
      ]
        .map((name) => `export * from './packages/core/src/${name}.ts';`)
        .join("\n"),
    );
    fs.writeFileSync(
      path.join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@elizaos/core": ["./task-core.ts"],
            "@elizaos/core/protocol": ["./task-core.ts"],
            // Retain source aliases for building older immutable commits.
            "@elizaos/plugin-browser/native-wire": [
              "./plugins/plugin-browser/src/native-wire.ts",
            ],
            "@elizaos/core/errors": ["./packages/core/src/errors.ts"],
            "@elizaos/core/messaging/interactive-task": [
              "./packages/core/src/messaging/interactive-task.ts",
            ],
            "@elizaos/core/messaging/interactions/sessions": [
              `./packages/core/src/${interactionSources.sessions}.ts`,
            ],
            "@elizaos/core/messaging/interactions/profiles": [
              `./packages/core/src/${interactionSources.profiles}.ts`,
            ],
            "@elizaos/core/messaging/interactions/profile-catalog": [
              `./packages/core/src/${interactionSources["profile-catalog"]}.ts`,
            ],
            "@elizaos/core/messaging/task-widgets": [
              "./packages/core/src/messaging/task-widgets.ts",
            ],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(temporary, "entry.ts"),
      ["store", "runtime", "http", "choices", "presentation"]
        .map(
          (name) =>
            `export * from './packages/agent/src/services/interactive-task-${name}.ts';`,
        )
        .join("\n") +
        (fs.existsSync(
          path.join(
            temporary,
            "plugins/plugin-browser/src/native-surface-target.ts",
          ),
        )
          ? "\nexport * from './plugins/plugin-browser/src/native-surface-target.ts';"
          : "") +
        `\nexport * from './packages/agent/src/services/sqlite-message-interaction-session-store.ts';\nexport * from './packages/core/src/${interactionSources.sessions}.ts';\nexport * from './plugins/plugin-browser/src/native-socket-target.ts';\nexport * from './plugins/plugin-browser/src/task-actuator.ts';\nexport * from './plugins/plugin-google-workspace/src/task-code-resolver.ts';`,
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync(
      "bun",
      [
        "build",
        "entry.ts",
        "--target=node",
        "--minify",
        "--outfile",
        path.resolve(output),
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    const provenance = { ...spec, bundleSha256: hash(fs.readFileSync(output)) };
    fs.writeFileSync(
      `${output}.json`,
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    if (browserSource) {
      /** @type {Record<string,string>} */
      const files = {};
      for (const name of [
        "errors.ts",
        "utils/errors.ts",
        "messaging/task-events.ts",
        "messaging/task-widgets.ts",
        "types/interactions.ts",
        "ui/TaskChoice.tsx",
        "voice/speech-segments.ts",
      ]) {
        const source =
          name === "voice/speech-segments.ts"
            ? "packages/ui/src/voice/speech-segments.ts"
            : name === "ui/TaskChoice.tsx"
              ? "packages/ui/src/components/chat/TaskChoice.tsx"
              : path.join("packages/core/src", name);
        const bytes = fs.readFileSync(path.join(temporary, source));
        const destination = path.join(browserSource, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (
          !fs.existsSync(destination) ||
          !fs.readFileSync(destination).equals(bytes)
        )
          fs.writeFileSync(destination, bytes);
        files[name] = hash(bytes);
      }
      fs.writeFileSync(
        path.join(browserSource, "provenance.json"),
        `${JSON.stringify({ ...spec, files }, null, 2)}\n`,
      );
    }
    if (commandSource) {
      const commandDirectory = path.resolve(commandSource);
      const commandOutput = path.join(commandDirectory, "command-handler.mjs");
      fs.mkdirSync(commandDirectory, { recursive: true });
      execFileSync(
        "bun",
        [
          "build",
          "packages/os/browser/src/command-handler.mjs",
          "--target=node",
          "--outfile",
          commandOutput,
        ],
        { cwd: temporary, stdio: "pipe" },
      );
      fs.writeFileSync(
        path.join(commandDirectory, "provenance.json"),
        JSON.stringify(
          { ...spec, bundleSha256: hash(fs.readFileSync(commandOutput)) },
          null,
          2,
        ) + "\n",
      );
    }
    return provenance;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: node scripts/build-consumer-task-runtime.mjs OUTPUT SOURCE_ROOT REVIEWED_COMMIT",
    );
  console.log(
    JSON.stringify(
      buildTaskRuntime(process.argv[2], {
        sourceRoot: path.resolve(process.argv[3]),
        sourceCommit: process.argv[4],
      }),
    ),
  );
}
