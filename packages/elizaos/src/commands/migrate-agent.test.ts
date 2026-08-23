/**
 * Tests for the `migrate-agent` command orchestration: argument validation and
 * its ordering, --json stdout purity, firewal flag resolution, artifact
 * emission, and encrypted archive writing. The REAL migrate pipeline runs over
 * OpenClaw-style fixture homes on disk; only the process streams are captured.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_PASSWORD_LENGTH } from "../migrate/index.js";
import { migrateAgent } from "./migrate-agent.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Create a throwaway OpenClaw-style agent home with the given flat files. */
function makeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(tmpdir(), "oc-migrate-cmd-"));
  tempRoots.push(home);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(home, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return home;
}

/** A dated daily-log body under memory/, N days before today. */
function dayLog(daysAgo: number, body: string): Record<string, string> {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { [`memory/${iso}.md`]: body };
}

interface CapturedRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Drive migrateAgent, intercepting stdout/stderr and process.exit(code). */
async function captureRun(
  opts: Parameters<typeof migrateAgent>[0],
): Promise<CapturedRun> {
  let out = "";
  let err = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  let code: number | null = null;
  try {
    await migrateAgent(opts);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const matched = /^exit:(\d+)$/.exec(message);
    if (!matched) {
      throw caught;
    }
    code = Number(matched[1]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { code, stdout: out, stderr: err };
}

const PERSONA_HOME = () =>
  makeHome({
    "SOUL.md": "# Solstice\nYou are Solstice, a careful migration guide.\n",
    "USER.md": "The human prefers tea.\n",
    ...dayLog(1, "recent daily log entry\n"),
    ...dayLog(60, "archived daily log entry\n"),
  });

describe("migrate-agent validation", () => {
  it("reports the --from error first when both required args are missing", async () => {
    const run = await captureRun({ json: true });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "--from <ocplatform-home> is required (e.g. ~/.moltbot).",
    );
    expect(run.stderr).not.toContain("--agent-id");
  });

  it("requires --agent-id once --from is present", async () => {
    const run = await captureRun({ from: "/nonexistent-home", json: true });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--agent-id <slug> is required (e.g. sol).");
  });

  it("treats a whitespace-only --from as missing", async () => {
    const run = await captureRun({ from: "   ", agentId: "sol", json: true });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--from <ocplatform-home> is required");
  });

  it("fails with Home not found for a missing source directory", async () => {
    const missing = path.join(tmpdir(), "oc-missing-home-does-not-exist");

    const run = await captureRun({ from: missing, agentId: "sol", json: true });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`Home not found: ${missing}`);
  });

  it("rejects a negative --memory-days", async () => {
    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      memoryDays: "-3",
      dryRun: true,
      json: true,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "--memory-days must be a non-negative number.",
    );
  });

  it("routes a human-mode failure through cancel on stdout, not stderr", async () => {
    const run = await captureRun({});

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      "--from <ocplatform-home> is required (e.g. ~/.moltbot).",
    );
    expect(run.stderr).toBe("");
  });
});

describe("migrate-agent --json output", () => {
  it("emits pure machine-parseable JSON describing the real plan", async () => {
    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      dryRun: true,
      json: true,
    });

    expect(run.code).toBeNull();
    expect(run.stdout).not.toContain("migrate-agent:");
    expect(run.stdout).not.toContain("Migration plan");
    const parsed = JSON.parse(run.stdout) as {
      character: { name?: string };
      counts: Record<string, number>;
      summary: { hasUser: boolean; firewalled: boolean };
      memoryCount: number;
    };
    // Name comes from the leading SOUL H1, not the agent-id slug.
    expect(parsed.character.name).toBe("Solstice");
    expect(parsed.summary.hasUser).toBe(true);
    expect(parsed.summary.firewalled).toBe(true);
    expect(parsed.memoryCount).toBeGreaterThan(0);
    for (const tier of ["CURRENT", "LONGTERM", "SELF", "MARKER"]) {
      expect(parsed.counts).toHaveProperty(tier);
    }
  });

  it("returns before writing anything, ignoring --out and --emit-* flags", async () => {
    const outPath = path.join(makeHome({}), "nested", "agent.eliza-agent");
    const charPath = path.join(makeHome({}), "character.json");
    const memPath = path.join(makeHome({}), "memories.jsonl");
    const password = "p".repeat(MIN_PASSWORD_LENGTH);

    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      json: true,
      out: outPath,
      password,
      emitCharacter: charPath,
      emitMemories: memPath,
    });

    expect(run.code).toBeNull();
    JSON.parse(run.stdout);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(charPath)).toBe(false);
    expect(fs.existsSync(memPath)).toBe(false);
  });

  it("routes reader warnings to stderr behind a 'warning:' prefix", async () => {
    const empty = makeHome({});

    const run = await captureRun({
      from: empty,
      agentId: "ghost",
      dryRun: true,
      json: true,
    });

    expect(run.code).toBeNull();
    expect(run.stderr).toMatch(/^warning: /m);
    JSON.parse(run.stdout);
  });

  it("resolves firewall flags: noFirewall wins over firewall, default is on", async () => {
    const home = PERSONA_HOME();
    const readFired = async (opts: {
      firewall?: boolean;
      noFirewall?: boolean;
    }) => {
      const run = await captureRun({
        from: home,
        agentId: "sol",
        dryRun: true,
        json: true,
        ...opts,
      });
      expect(run.code).toBeNull();
      return (JSON.parse(run.stdout) as { summary: { firewalled: boolean } })
        .summary.firewalled;
    };

    expect(await readFired({})).toBe(true);
    expect(await readFired({ firewall: true, noFirewall: true })).toBe(false);
    expect(await readFired({ noFirewall: true })).toBe(false);
  });

  it("applies the default 14-day memory window unless --memory-days widens it", async () => {
    const home = makeHome({
      "SOUL.md": "# Solstice\nYou are Solstice.\n",
      ...dayLog(60, "archived daily log entry\n"),
    });
    // The window only governs the unfirewalled corpus: with the firewall on
    // (the default) real memories are never seeded, so observe via noFirewall.
    const readCurrent = async (memoryDays?: string) => {
      const run = await captureRun({
        from: home,
        agentId: "sol",
        memoryDays,
        noFirewall: true,
        dryRun: true,
        json: true,
      });
      expect(run.code).toBeNull();
      return JSON.parse(run.stdout) as { counts: Record<string, number> };
    };

    // 60-day-old logs fall outside the implicit 14-day window and become an
    // older-history marker instead...
    expect((await readCurrent()).counts.CURRENT).toBe(0);
    expect((await readCurrent()).counts.MARKER).toBeGreaterThan(0);
    // ...but are seeded verbatim once the caller widens the window.
    expect((await readCurrent("3650")).counts.CURRENT).toBeGreaterThan(0);
  });
});

describe("migrate-agent artifacts", () => {
  it("writes nothing on --dry-run and prints the dry-run outro", async () => {
    const outPath = path.join(makeHome({}), "agent.eliza-agent");

    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      out: outPath,
      password: "p".repeat(MIN_PASSWORD_LENGTH),
      dryRun: true,
    });

    expect(run.code).toBeNull();
    expect(run.stdout).toContain("dry-run: nothing written.");
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("emits sovereign-local character JSON and memories JSONL with parent dirs", async () => {
    const target = makeHome({});
    const charPath = path.join(target, "deep", "dir", "character.json");
    const memPath = path.join(target, "deep", "dir", "memories.jsonl");

    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      emitCharacter: charPath,
      emitMemories: memPath,
    });

    expect(run.code).toBeNull();
    expect(fs.existsSync(charPath)).toBe(true);

    const character = JSON.parse(fs.readFileSync(charPath, "utf-8")) as {
      name?: string;
    };
    expect(character.name).toBe("Solstice");

    const lines = fs
      .readFileSync(memPath, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { text: string; tier?: string });
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of lines) {
      expect(typeof entry.text).toBe("string");
      expect(typeof entry.tier).toBe("string");
    }

    // The JSONL corpus matches the real plan's memory count for the same input.
    const { buildMigrationPlan } = await import("../migrate/index.js");
    const plan = buildMigrationPlan({
      from: target,
      agentId: "sol",
      memoryDays: 14,
      firewall: true,
    });
    expect(lines.length).toBe(plan.memories.length);
    expect(run.stdout).toContain(`memories (${plan.memories.length}) →`);
    expect(run.stdout).toContain("migrate-agent done.");
  });

  it("writes an encrypted V1 archive behind nested parent dirs", async () => {
    const outPath = path.join(makeHome({}), "a", "b", "agent.eliza-agent");

    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      out: outPath,
      password: "p".repeat(MIN_PASSWORD_LENGTH),
    });

    expect(run.code).toBeNull();
    expect(fs.existsSync(outPath)).toBe(true);
    const buf = fs.readFileSync(outPath);
    expect(buf.length).toBeGreaterThan(64);
    expect(buf.subarray(0, 15).toString("utf-8")).toBe("ELIZA_AGENT_V1\n");
    expect(run.stdout).toContain(`archive → ${outPath} (${buf.length} bytes)`);
  });

  it("refuses an archive whose password is missing or below the minimum", async () => {
    const home = PERSONA_HOME();

    const missing = await captureRun({
      from: home,
      agentId: "sol",
      out: path.join(home, "out.eliza-agent"),
    });
    expect(missing.code).toBe(1);
    // Human mode routes the refusal through clack.cancel on stdout.
    expect(missing.stdout).toContain(
      `--password (min ${MIN_PASSWORD_LENGTH} chars) is required`,
    );
    expect(fs.existsSync(path.join(home, "out.eliza-agent"))).toBe(false);

    const short = await captureRun({
      from: home,
      agentId: "sol",
      out: path.join(home, "out.eliza-agent"),
      password: "short",
    });
    expect(short.code).toBe(1);
    expect(short.stdout).toContain(
      `--password (min ${MIN_PASSWORD_LENGTH} chars) is required`,
    );
    expect(fs.existsSync(path.join(home, "out.eliza-agent"))).toBe(false);
  });

  it("warns on stdout when an unfirewalled archive includes personal knowledge", async () => {
    const outPath = path.join(makeHome({}), "leaky.eliza-agent");

    const run = await captureRun({
      from: PERSONA_HOME(),
      agentId: "sol",
      out: outPath,
      password: "p".repeat(MIN_PASSWORD_LENGTH),
      noFirewall: true,
    });

    expect(run.code).toBeNull();
    expect(run.stdout).toContain("Firewall DISABLED");
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("warns when no output destination was requested", async () => {
    const run = await captureRun({ from: PERSONA_HOME(), agentId: "sol" });

    expect(run.code).toBeNull();
    expect(run.stdout).toContain("No output requested.");
    expect(run.stdout).toContain("migrate-agent done.");
  });
});
