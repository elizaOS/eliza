import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createBenchmarkPlugin,
  getBenchmarkContext,
  runWithBenchmarkContext,
} from "./plugin.js";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;
const state = {} as State;
const plugin = createBenchmarkPlugin();
const provider = plugin.providers?.[0];
const action = plugin.actions?.find(
  (candidate) => candidate.name === "BENCHMARK_ACTION",
);

if (!provider || !action) throw new Error("Missing benchmark plugin contracts");

async function capture(command: string) {
  if (!action) throw new Error("Missing benchmark action");
  await action.handler(runtime, message, state, { parameters: { command } });
}

describe("benchmark turn scope", () => {
  it("isolates overlapping contexts and returns only each turn's actions", async () => {
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = runWithBenchmarkContext(
      { benchmark: "a", taskId: "a" },
      async () => {
        await capture("first");
        await resumed;
        expect(getBenchmarkContext()?.taskId).toBe("a");
        await capture("last");
        return "a";
      },
    );
    const second = await runWithBenchmarkContext(
      { benchmark: "b", taskId: "b" },
      async () => {
        await capture("second");
        return "b";
      },
    );
    resume();
    expect(second.capturedActions.map((item) => item.command)).toEqual([
      "second",
    ]);
    expect((await first).capturedActions.map((item) => item.command)).toEqual([
      "first",
      "last",
    ]);
    expect(getBenchmarkContext()).toBeNull();
  });

  it("restores a parent scope after a rejected nested turn", async () => {
    await runWithBenchmarkContext(
      { benchmark: "parent", taskId: "parent" },
      async () => {
        await expect(
          runWithBenchmarkContext(
            { benchmark: "child", taskId: "child" },
            () => {
              throw new Error("failed turn");
            },
          ),
        ).rejects.toThrow("failed turn");
        expect(getBenchmarkContext()?.taskId).toBe("parent");
      },
    );
    expect(getBenchmarkContext()).toBeNull();
    await expect(capture("outside")).rejects.toThrow("active turn");
  });
});

it("renders complete selected context, including long schemas, HTML, elements and early tool results", async () => {
  const longText = `${"x".repeat(4000)}END_OF_SOURCE`;
  const context = {
    benchmark: "lifeops-bench",
    taskId: "complete",
    html: longText,
    tools: [
      {
        name: "calendar",
        description: longText,
        parameters: { description: longText },
      },
    ],
    elements: Array.from({ length: 20 }, (_, id) => ({
      id,
      text_content: longText,
      attributes: { extra: longText },
    })),
    lifeops: {
      calendarEvents: Array.from({ length: 90 }, (_, id) => ({
        id,
        description: longText,
      })),
      previousToolResults: Array.from({ length: 20 }, (_, id) => ({
        id,
        result: longText,
      })),
    },
  };
  const { result } = await runWithBenchmarkContext(context, () =>
    provider?.get(runtime, message, state),
  );
  expect(result?.text).toContain(context.html);
  expect(result?.text).toContain(JSON.stringify(context.elements, null, 2));
  expect(result?.text).toContain(JSON.stringify(context.lifeops, null, 2));
  expect(result?.text).toContain(
    JSON.stringify(context.tools[0].parameters, null, 2),
  );
});

it("keeps lifecycle context restricted to its authorized shared hint", async () => {
  const { result } = await runWithBenchmarkContext(
    {
      benchmark: "orchestrator_lifecycle",
      taskId: "private",
      system_hint: "authorized",
      goal: "hidden answer",
      observation: "private evaluation",
    },
    () => provider?.get(runtime, message, state),
  );
  expect(result?.text).toBe("authorized");
});
