/** Publish the assistant policy plugin and its explicit action and prompt entry points. */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
await rm(`${root}dist`, { recursive: true, force: true });
await build({
  entry: {
    index: `${root}src/index.ts`,
    "actions/context-signal": `${root}src/actions/context-signal.ts`,
    "actions/context-signal-lexicon": `${root}src/actions/context-signal-lexicon.ts`,
    "device-calendar-contract": `${root}src/services/device-actions/calendar-contract.ts`,
    "device-foreground-review": `${root}src/services/device-actions/foreground-review-contract.ts`,
    "device-clock-review": `${root}src/services/device-actions/clock-review-executor.ts`,
    "device-reminder-journal": `${root}src/services/device-actions/reminder-journal.ts`,
    "character-persistence": `${root}src/features/advanced-capabilities/personality/character-persistence.ts`,
    "actions/generate-media": `${root}src/features/advanced-capabilities/actions/generateMedia.ts`,
    "prompts/response-policy": `${root}src/prompts/response-policy.ts`,
    "text/template-engine": `${root}src/text/template-engine.ts`,
    "text/template-rendering": `${root}src/text/template-rendering.ts`,
    "html-entities": `${root}src/utils/html-entities.ts`,
  },
  outDir: `${root}dist`,
  tsconfig: `${root}tsconfig.build.json`,
  platform: "node",
  target: "node24",
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ],
  clean: true,
});
