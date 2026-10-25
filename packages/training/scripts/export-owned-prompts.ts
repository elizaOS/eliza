/** Reads complete evaluated templates from their owning runtime modules for training extraction. */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sources = [
  "packages/agent/src/api/custom-action-prompt.ts",
  "packages/agent/src/api/memory-context-prompt.ts",
  "packages/agent/src/runtime/default-character-prompt.ts",
  "packages/agent/src/runtime/observation-prompt.ts",
  "plugins/plugin-assistant/src/features/advanced-capabilities/prompts.ts",
  "plugins/plugin-assistant/src/features/advanced-memory/prompts.ts",
  "plugins/plugin-assistant/src/features/advanced-planning/prompts.ts",
  "plugins/plugin-assistant/src/features/autonomy/prompts.ts",
  "plugins/plugin-assistant/src/features/basic-capabilities/contact-prompts.ts",
  "plugins/plugin-assistant/src/features/basic-capabilities/prompts.ts",
  "plugins/plugin-assistant/src/features/secrets/prompts.ts",
  "plugins/plugin-assistant/src/prompts/response-policy.ts",
  "plugins/plugin-assistant/src/runtime/actions/parameter-prompt.ts",
  "plugins/plugin-assistant/src/services/message/prompts.ts",
];
const entries: { name: string; source_path: string; template: string }[] = [];
for (const source of sources) {
  const exports = await import(pathToFileURL(resolve(root, source)).href);
  for (const [name, template] of Object.entries(exports)) {
    if (/^[a-z].*Template$/.test(name) && typeof template === "string") {
      entries.push({ name, source_path: source, template });
    }
  }
}
process.stdout.write(JSON.stringify(entries));
