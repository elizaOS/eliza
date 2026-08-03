/** Verifies that app-core dev hosts never let runtime children mutate dependencies. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

describe.each([
  [
    "dev-platform",
    path.join(scriptsDir, "dev-platform.mjs"),
    'const apiSourceConditionArgs = ["--no-install", "--conditions=eliza-source"];',
  ],
  [
    "dev-ui",
    path.join(scriptsDir, "dev-ui.mjs"),
    '...(apiRuntimeIsBun ? ["--no-install"] : []),',
  ],
])("%s API child command", (_name, scriptPath, noInstallSource) => {
  it("disables Bun auto-install for the runtime process", () => {
    const source = readFileSync(scriptPath, "utf8");

    expect(source).toContain(noInstallSource);
    expect(source).toContain('"--conditions=eliza-source"');
  });
});
