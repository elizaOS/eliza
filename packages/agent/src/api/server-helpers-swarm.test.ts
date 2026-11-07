import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSwarmSynthesis } from "./server-helpers-swarm.ts";

let workdir: string;

beforeAll(() => {
  workdir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-synthesis-")),
  );
});

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

async function synthesize(completionSummary: string): Promise<string[]> {
  const delivered: string[] = [];
  await handleSwarmSynthesis(
    { runtime: { getService: () => null } as unknown as AgentRuntime },
    {
      tasks: [
        {
          sessionId: "session-1",
          label: "report",
          agentType: "codex",
          originalTask: "write the report",
          status: "completed",
          completionSummary,
          workdir,
        },
      ],
      total: 1,
      completed: 1,
      stopped: 0,
      errored: 0,
    },
    async (text) => {
      delivered.push(text);
    },
  );
  return delivered;
}

describe("handleSwarmSynthesis", () => {
  it.each(["cost_$$_$&.md", "cost_$$_$&.log"])(
    "replaces the local path of %s with its literal file name",
    async (name) => {
      const filePath = path.join(workdir, name);
      fs.writeFileSync(filePath, "total");

      expect(
        await synthesize(
          `Saved to \`${filePath}\` and copied ${filePath} too.`,
        ),
      ).toEqual([`Saved to ${name} and copied ${name} too.`]);
    },
  );
});
