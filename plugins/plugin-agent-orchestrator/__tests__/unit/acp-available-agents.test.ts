import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import { clearTaskAgentFrameworkStateCache } from "../../src/services/task-agent-frameworks.js";

const original = {
  PATH: process.env.PATH,
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  ELIZA_ELIZAOS_ACP_COMMAND: process.env.ELIZA_ELIZAOS_ACP_COMMAND,
};
let binDir = "";

beforeEach(() => {
  clearTaskAgentFrameworkStateCache();
  binDir = mkdtempSync(join(tmpdir(), "eliza-agent-inventory-"));
  process.env.PATH = binDir;
  process.env.CEREBRAS_API_KEY = "synthetic-inventory-key";
  process.env.ELIZA_ELIZAOS_ACP_COMMAND = "eliza-code-acp";
  const executable = join(binDir, "eliza-code-acp");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(executable, 0o755);
});

afterEach(() => {
  clearTaskAgentFrameworkStateCache();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(binDir, { recursive: true, force: true });
});

function runtime(): IAgentRuntime {
  return {
    getSetting: (key: string) => process.env[key],
    getService: () => null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
}

describe("AcpService adapter inventory", () => {
  it("reports only detected binaries and provider readiness", async () => {
    const service = new AcpService(runtime());
    const inventory = await service.getAvailableAgents();

    expect(
      inventory.find((agent) => agent.agentType === "elizaos"),
    ).toMatchObject({ installed: true, auth: { status: "authenticated" } });
    expect(
      inventory.find((agent) => agent.agentType === "claude"),
    ).toMatchObject({ installed: false, auth: { status: "unknown" } });
    expect(
      inventory.find((agent) => agent.agentType === "codex"),
    ).toMatchObject({ installed: false, auth: { status: "unknown" } });
  });
});
