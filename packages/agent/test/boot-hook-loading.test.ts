/** Load real optional hook modules and preserve transitive loader failures. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { resolveBootHookContributors } from "../src/runtime/boot-hooks.ts";

it("runs a present hook, skips an absent package, and rejects a broken hook dependency", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-boot-hook-"));
  const runtime = new AgentRuntime({
    character: { name: "Hook host", bio: [] },
    logLevel: "fatal",
  });
  const invoke = (specifier: string) =>
    resolveBootHookContributors([
      { id: "fixture", specifier, exportName: "boot" },
    ])[0].invoke(runtime);
  try {
    const receipt = path.join(dir, "receipt");
    const present = path.join(dir, "present.mjs");
    await writeFile(
      present,
      `import fs from "node:fs"; export function boot(runtime) { fs.writeFileSync(${JSON.stringify(receipt)}, runtime.character.name); }`,
    );
    await invoke(pathToFileURL(present).href);
    expect(await readFile(receipt, "utf8")).toBe("Hook host");
    await invoke(`@elizaos/absent-hook-${randomUUID()}`);
    const broken = path.join(dir, "broken.mjs");
    await writeFile(
      broken,
      'import "absent-hook-transitive-dependency"; export function boot() {}',
    );
    await expect(invoke(pathToFileURL(broken).href)).rejects.toThrow(
      "absent-hook-transitive-dependency",
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
