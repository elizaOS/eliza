import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import { runFinalCheck } from "./index";

const runtime = {} as IAgentRuntime;

function createContext(
  overrides: Partial<ScenarioContext> = {},
): ScenarioContext {
  return {
    actionsCalled: [],
    memoryWrites: [],
    ...overrides,
  };
}

describe("memoryExists finalCheck", () => {
  it("passes when a captured memory write matches the requested content", async () => {
    const result = await runFinalCheck(
      {
        type: "memoryExists",
        content: {
          text: { $contains: "submit report" },
        },
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          memoryWrites: [
            {
              table: "messages",
              content: {
                text: "Added todo: Submit Report.",
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      type: "memoryExists",
      status: "passed",
      detail: "1 matching memory write(s)",
    });
  });

  it("fails when no captured memory write matches the requested content", async () => {
    const result = await runFinalCheck(
      {
        type: "memoryExists",
        content: {
          text: { $contains: "timesheet" },
        },
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          memoryWrites: [
            {
              table: "messages",
              content: {
                text: "Added todo: Submit Report.",
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      type: "memoryExists",
      status: "failed",
      detail: "expected 1 matching memory write(s), saw 0 of 1 total",
    });
  });

  it("supports table filters, minCount, and negative checks", async () => {
    const ctx = createContext({
      memoryWrites: [
        { table: "messages", content: { text: "take vitamins" } },
        { table: "messages", content: { text: "vitamins overdue" } },
        { table: "facts", content: { text: "vitamins" } },
      ],
    });

    await expect(
      runFinalCheck(
        {
          type: "memoryExists",
          table: "messages",
          content: { text: { $contains: "vitamins" } },
          minCount: 2,
        } as ScenarioFinalCheck,
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });

    await expect(
      runFinalCheck(
        {
          type: "memoryExists",
          table: "messages",
          content: { text: { $contains: "deleted" } },
          expected: false,
        } as ScenarioFinalCheck,
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });
  });
});
