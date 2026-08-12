/**
 * Exercises the agent-server capacity boundary through the real manager API
 * and a subprocess boot while keeping runtime initialization out of the unit
 * harness.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { AgentManager } from "../../src/agent-manager";

const originalCapacity = process.env.CAPACITY;

afterEach(() => {
  if (originalCapacity === undefined) {
    delete process.env.CAPACITY;
  } else {
    process.env.CAPACITY = originalCapacity;
  }
});

function reserveAgent(manager: AgentManager, agentId: string): void {
  (
    manager as unknown as {
      agents: Map<string, unknown>;
    }
  ).agents.set(agentId, {
    agentId,
    characterRef: "test:character",
    state: "stopped",
  });
}

describe("AgentManager capacity", () => {
  test("reports and enforces the parsed capacity after the environment changes", async () => {
    const manager = new AgentManager(1);
    reserveAgent(manager, "reserved-agent");
    process.env.CAPACITY = "200";

    expect(manager.getStatus()).toMatchObject({
      capacity: 1,
      agentCount: 1,
    });
    await expect(
      manager.startAgent("overflow-agent", "test:character"),
    ).rejects.toThrow("At capacity");
  });

  test("rejects malformed capacity before opening Redis or listening", async () => {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      child = Bun.spawn(
        [process.execPath, "--conditions=eliza-source", "run", "src/index.ts"],
        {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          env: {
            SERVER_NAME: "capacity-test",
            REDIS_URL: "redis://127.0.0.1:1",
            DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
            CAPACITY: "1e2",
            TIER: "test",
            AGENT_SERVER_SHARED_SECRET: "test-secret",
            MOCK_REDIS: "1",
            PORT: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      deadline = setTimeout(() => {
        timedOut = true;
        child?.kill();
      }, 5_000);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = `${stdout}${stderr}`;

      expect(timedOut).toBe(false);
      expect(exitCode).toBe(1);
      expect(output).toContain(
        "CAPACITY must be a canonical decimal integer from 1 to 200",
      );
      expect(output).not.toContain("[redis] using in-memory mock");
      expect(output).not.toContain("Agent-server listening");
    } finally {
      if (deadline) clearTimeout(deadline);
      if (child?.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  });
});
