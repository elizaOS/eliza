/** Guards the runtime plugin entry from pulling browser-only React views into Bun server boot. */

import { readFile } from "node:fs/promises";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getCircadianInsightContract, healthPlugin } from "../index.js";

describe("plugin-health server entry boundary", () => {
  it("keeps UI barrels and components behind the dedicated UI subpath", async () => {
    const source = await readFile(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/export\s+\*\s+from\s+["']\.\/ui\//);
    expect(source).not.toMatch(/from\s+["']\.\/components\//);
  });

  it("loads and initializes the server entry without browser-only dependencies", async () => {
    const runtime = {} as IAgentRuntime;

    await healthPlugin.init?.({}, runtime);

    expect(healthPlugin.name).toBe("plugin-health");
    expect(getCircadianInsightContract(runtime)).not.toBeNull();
  });
});
