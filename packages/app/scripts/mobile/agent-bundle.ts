/** Owns the mobile agent bundle build using the shared build context and existing platform contracts. */

import path from "node:path";
import { run } from "./build-tools.ts";
import { packagesRoot } from "./context.ts";
import { resolveBunExecutable } from "./toolchain.ts";

export async function buildMobileAgentBundle({ target = "android" } = {}) {
  const bun = resolveBunExecutable();
  if (!bun) {
    throw new Error(
      "bun executable not found; run bun install before mobile local builds.",
    );
  }
  const script = target === "ios" ? "build:ios-bun" : "build:mobile";
  await run(bun, ["run", script], {
    cwd: path.join(packagesRoot, "agent"),
  });
}
