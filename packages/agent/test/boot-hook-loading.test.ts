/** Load real optional hook modules and preserve transitive loader failures. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { loadHooks } from "../src/hooks/loader.ts";
import {
  clearHooks,
  createHookEvent,
  triggerHook,
} from "../src/hooks/registry.ts";
import { resolveBootHookContributors } from "../src/runtime/boot-hooks.ts";
import { loadOptionalPlugin } from "../src/runtime/optional-plugin-loader.ts";

it("discovers and executes declared workspace hooks while rejecting malformed frontmatter", async () => {
  const workspacePath = await mkdtemp(
    path.join(tmpdir(), "agent-workspace-hook-"),
  );
  try {
    const receipt = path.join(workspacePath, "receipt");
    for (const [name, frontmatter] of [
      [
        "valid",
        'name: valid\ndescription: Workspace hook\nmetadata:\n  eliza:\n    events: ["session:start"]',
      ],
      [
        "invalid",
        'name: invalid\ndescription: Workspace hook\nmetadata: {"eliza":{"events":["session:start"]}} trailing garbage',
      ],
    ]) {
      const directory = path.join(workspacePath, "hooks", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "HOOK.md"),
        `---\n${frontmatter}\n---\n`,
      );
      await writeFile(
        path.join(directory, "handler.mjs"),
        `import fs from "node:fs"; export default function(event) { fs.appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(name)} + ":" + event.sessionKey + "\\n"); }`,
      );
    }
    expect(await loadHooks({ workspacePath })).toMatchObject({
      discovered: 1,
      registered: 1,
      failed: [],
    });
    await triggerHook(createHookEvent("session", "start", "real-session"));
    expect(await readFile(receipt, "utf8")).toBe("valid:real-session\n");
  } finally {
    clearHooks();
    await rm(workspacePath, { recursive: true, force: true });
  }
});

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

it("loads real optional plugin modules and surfaces broken transitive imports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-optional-plugin-"));
  try {
    const present = path.join(dir, "present.mjs");
    await writeFile(present, 'export default { name: "fixture-plugin" };');
    expect(
      await loadOptionalPlugin(pathToFileURL(present).href, dir),
    ).toMatchObject({
      default: { name: "fixture-plugin" },
    });
    expect(
      await loadOptionalPlugin(`@elizaos/absent-plugin-${randomUUID()}`, dir),
    ).toBeNull();
    const broken = path.join(dir, "broken.mjs");
    await writeFile(
      broken,
      'import "absent-plugin-transitive-dependency"; export default {};',
    );
    await expect(
      loadOptionalPlugin(pathToFileURL(broken).href, dir),
    ).rejects.toMatchObject({
      code: "OPTIONAL_PLUGIN_LOAD_FAILED",
      cause: expect.objectContaining({
        message: expect.stringContaining("absent-plugin-transitive-dependency"),
      }),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
