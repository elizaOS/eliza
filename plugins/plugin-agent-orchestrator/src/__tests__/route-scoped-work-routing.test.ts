import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";
import { routeScopedWorkRoutingEvaluator } from "../evaluators/route-scoped-work-routing.js";

const repo = mkdtempSync(`${tmpdir()}/milady-fork-`);
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function runtime(): IAgentRuntime {
  return {
    getSetting: (key: string) =>
      key === "TASK_AGENT_WORKDIR_ROUTES"
        ? JSON.stringify([
            { id: "milady-pr-work", workdir: repo, matchAny: ["milady-fork"] },
          ])
        : undefined,
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "m1",
    entityId: "u1",
    roomId: "r1",
    content: { text, source: "discord" },
  } as unknown as Memory;
}

function evaluate(text: string, candidates: string[]) {
  return routeScopedWorkRoutingEvaluator.evaluate({
    runtime: runtime(),
    message: message(text),
    messageHandler: {
      processMessage: "RESPOND",
      plan: { contexts: ["code"], candidateActions: candidates },
    },
  } as never);
}

describe("route-scoped work routing", () => {
  it("replaces a shell candidate with TASKS when the ask names a route", async () => {
    const patch = await evaluate(
      "in the milady-fork repo, count how many .ts files are under apps/",
      ["TERMINAL"],
    );
    expect(patch).toMatchObject({
      clearCandidateActions: true,
      addCandidateActions: ["TASKS"],
    });
  });

  it("leaves a shell ask alone when no route is named", async () => {
    expect(
      await evaluate("how much disk is free?", ["TERMINAL"]),
    ).toBeUndefined();
  });

  it("leaves a route-scoped ask alone when stage-1 already chose delegation", async () => {
    expect(
      await evaluate("fix the readme typo in milady-fork", [
        "TASKS_SPAWN_AGENT",
      ]),
    ).toBeUndefined();
  });
});
