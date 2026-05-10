import { describe, expect, test } from "bun:test";

function runGateScenario(balance: number | null) {
  const script = `
    import { mock } from "bun:test";

    mock.module("@/db/repositories", () => ({
      organizationsRepository: {
        findById: async () => ${
          balance === null ? "null" : `({ id: "org-1", credit_balance: ${JSON.stringify(String(balance))} })`
        },
      },
    }));

    mock.module("@/lib/utils/logger", () => ({
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      },
    }));

    const { checkAgentCreditGate } = await import("@/lib/services/agent-billing-gate");
    const result = await checkAgentCreditGate("org-1");
    console.log(JSON.stringify(result));
  `;

  const result = Bun.spawnSync({
    cmd: ["bun", "--eval", script],
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  return JSON.parse(result.stdout.toString()) as {
    allowed: boolean;
    balance: number;
    error?: string;
  };
}

describe("Agent billing gate", () => {
  test("blocks balances at or below ten cents", () => {
    expect(runGateScenario(0.1)).toMatchObject({
      allowed: false,
      balance: 0.1,
    });
  });

  test("allows balances greater than ten cents", () => {
    expect(runGateScenario(0.11)).toEqual({
      allowed: true,
      balance: 0.11,
    });
  });
});
