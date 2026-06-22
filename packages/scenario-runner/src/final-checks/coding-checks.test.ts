/**
 * Coding / sub-agent orchestration finalChecks (audit Wave 1.2).
 *
 * These give scenario authors first-class proof fields for the coding
 * capability: that a sub-agent was spawned, that files were mutated, and that
 * generated code actually builds (dynamic build validation). Without them, a
 * coding scenario could only assert on raw action names.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runFinalCheck } from "./index.ts";

const runtime = {} as unknown as IAgentRuntime;
const ctxWith = (actions: Array<Partial<CapturedAction>>): ScenarioContext =>
  ({
    actionsCalled: actions as CapturedAction[],
  }) as unknown as ScenarioContext;
const run = (check: unknown, ctx: ScenarioContext) =>
  runFinalCheck(check as never, { runtime, ctx });

describe("subAgentSpawned", () => {
  it("passes when a spawn action fired", async () => {
    const r = await run(
      { type: "subAgentSpawned", name: "spawned" },
      ctxWith([{ actionName: "TASKS_SPAWN_AGENT" }]),
    );
    expect(r.status).toBe("passed");
  });

  it("fails when no spawn action fired", async () => {
    const r = await run(
      { type: "subAgentSpawned", name: "spawned" },
      ctxWith([{ actionName: "REPLY" }, { actionName: "TASKS_LIST_AGENTS" }]),
    );
    expect(r.status).toBe("failed");
  });

  it("honors agentType matching against action params", async () => {
    const ctx = ctxWith([
      { actionName: "TASKS_CREATE", parameters: { agentType: "codex" } },
    ]);
    expect(
      (
        await run(
          { type: "subAgentSpawned", name: "x", agentType: "codex" },
          ctx,
        )
      ).status,
    ).toBe("passed");
    expect(
      (
        await run(
          { type: "subAgentSpawned", name: "x", agentType: "claude" },
          ctx,
        )
      ).status,
    ).toBe("failed");
  });

  it("respects minCount", async () => {
    const ctx = ctxWith([
      { actionName: "START_CODING_TASK" },
      { actionName: "START_CODING_TASK" },
    ]);
    expect(
      (await run({ type: "subAgentSpawned", name: "x", minCount: 2 }, ctx))
        .status,
    ).toBe("passed");
    expect(
      (await run({ type: "subAgentSpawned", name: "x", minCount: 3 }, ctx))
        .status,
    ).toBe("failed");
  });
});

describe("fileMutationOccurred", () => {
  it("passes for a write/edit action", async () => {
    expect(
      (
        await run(
          { type: "fileMutationOccurred", name: "wrote" },
          ctxWith([{ actionName: "WRITE_FILE" }]),
        )
      ).status,
    ).toBe("passed");
    expect(
      (
        await run(
          { type: "fileMutationOccurred", name: "wrote" },
          ctxWith([{ actionName: "FILE", parameters: { action: "write" } }]),
        )
      ).status,
    ).toBe("passed");
  });

  it("does NOT count a FILE read as a mutation", async () => {
    const r = await run(
      { type: "fileMutationOccurred", name: "wrote" },
      ctxWith([{ actionName: "FILE", parameters: { action: "read" } }]),
    );
    expect(r.status).toBe("failed");
  });

  it("honors path matching", async () => {
    const ctx = ctxWith([
      {
        actionName: "EDIT_FILE",
        parameters: { file_path: "/repo/src/index.ts" },
      },
    ]);
    expect(
      (
        await run(
          { type: "fileMutationOccurred", name: "x", path: "index.ts" },
          ctx,
        )
      ).status,
    ).toBe("passed");
    expect(
      (
        await run(
          { type: "fileMutationOccurred", name: "x", path: "nope.ts" },
          ctx,
        )
      ).status,
    ).toBe("failed");
  });
});

describe("buildValidation", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("passes when the command exits 0", async () => {
    dir = mkdtempSync(join(tmpdir(), "bv-pass-"));
    const r = await run(
      {
        type: "buildValidation",
        name: "build",
        workdir: dir,
        command: "exit 0",
      },
      ctxWith([]),
    );
    expect(r.status).toBe("passed");
  });

  it("fails when the command exits non-zero", async () => {
    dir = mkdtempSync(join(tmpdir(), "bv-fail-"));
    const r = await run(
      {
        type: "buildValidation",
        name: "build",
        workdir: dir,
        command: "exit 1",
      },
      ctxWith([]),
    );
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("exited 1");
  });

  it("passes a non-zero exit when expectExitZero is false", async () => {
    dir = mkdtempSync(join(tmpdir(), "bv-neg-"));
    const r = await run(
      {
        type: "buildValidation",
        name: "build",
        workdir: dir,
        command: "exit 2",
        expectExitZero: false,
      },
      ctxWith([]),
    );
    expect(r.status).toBe("passed");
  });

  it("skips (dependency missing) when the workdir does not exist", async () => {
    const r = await run(
      {
        type: "buildValidation",
        name: "build",
        workdir: join(tmpdir(), "definitely-not-here-xyz"),
        command: "exit 0",
      },
      ctxWith([]),
    );
    expect(r.status).toBe("skipped-dependency-missing");
  });

  it("actually validates real generated code (writes a TS file, typechecks via node --check on JS)", async () => {
    dir = mkdtempSync(join(tmpdir(), "bv-real-"));
    // a real compile check: node --check parses the file and fails on syntax error
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "good.js"), "const x = 1; module.exports = x;\n");
    writeFileSync(join(dir, "bad.js"), "const = ;\n");
    expect(
      (
        await run(
          {
            type: "buildValidation",
            name: "ok",
            workdir: dir,
            command: "node --check good.js",
          },
          ctxWith([]),
        )
      ).status,
    ).toBe("passed");
    expect(
      (
        await run(
          {
            type: "buildValidation",
            name: "bad",
            workdir: dir,
            command: "node --check bad.js",
          },
          ctxWith([]),
        )
      ).status,
    ).toBe("failed");
  });
});

describe("schema strictness", () => {
  it("rejects unknown fields on the new checks", async () => {
    const r = await run(
      { type: "subAgentSpawned", name: "x", bogusField: true },
      ctxWith([{ actionName: "TASKS_SPAWN_AGENT" }]),
    );
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("unknown field");
  });
});
