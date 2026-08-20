/**
 * Verifies the real filesystem instruction boundary used by the ACP child,
 * including compact orchestrator scaffolds and verbatim project manuals.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_ORCHESTRATOR_MANUAL,
  readWorkspaceManualForPrompt,
  workspaceManualForPrompt,
} from "./acp-workspace-manual.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eliza-code-manual-"));
  dirs.push(dir);
  return dir;
}

describe("ACP workspace manual", () => {
  it("uses the compact contract for an orchestrator scaffold", () => {
    const full = `# Eliza coding sub-agent — operating manual\n\n${"detail ".repeat(2_000)}`;
    const result = workspaceManualForPrompt(full);

    expect(result).toBe(COMPACT_ORCHESTRATOR_MANUAL);
    expect(result.length).toBeLessThan(1_200);
    expect(result).toContain("non-interactive");
    expect(result).toContain("Do not push");
    expect(result).toContain("Never print or commit secrets");
    expect(result).toContain("exact output");
    expect(result).toContain("Read that file only if");
  });

  it("keeps project-authored instructions byte-for-byte after edge trimming", () => {
    const projectManual =
      "\n# Project instructions\n\nRun the package-specific integration test.\n";
    expect(workspaceManualForPrompt(projectManual)).toBe(
      "# Project instructions\n\nRun the package-specific integration test.",
    );
  });

  it("prefers AGENTS.md and compacts a real scaffold file", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "AGENTS.md"),
      "# Eliza coding sub-agent — operating manual\n\nFull bridge detail.",
      "utf8",
    );
    await writeFile(join(dir, "CLAUDE.md"), "# Project fallback", "utf8");

    await expect(readWorkspaceManualForPrompt(dir)).resolves.toBe(
      COMPACT_ORCHESTRATOR_MANUAL,
    );
  });

  it("falls back to CLAUDE.md and returns empty when neither file exists", async () => {
    const withClaude = await makeDir();
    await writeFile(
      join(withClaude, "CLAUDE.md"),
      "# Project Claude instructions\nKeep this exact.",
      "utf8",
    );
    await expect(readWorkspaceManualForPrompt(withClaude)).resolves.toBe(
      "# Project Claude instructions\nKeep this exact.",
    );

    const empty = await makeDir();
    await expect(readWorkspaceManualForPrompt(empty)).resolves.toBe("");
    await expect(readWorkspaceManualForPrompt()).resolves.toBe("");
  });
});
