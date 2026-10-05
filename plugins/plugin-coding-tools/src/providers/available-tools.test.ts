/** Tests mutation isolation between reads of the real coding-tool provider. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { availableToolsProvider } from "./available-tools.js";

it("does not let a caller mutate the tool list returned to later turns", async () => {
  const first = await availableToolsProvider.get(
    {} as IAgentRuntime,
    {} as Memory,
  );
  const tools = first.data?.codingTools;
  if (!Array.isArray(tools)) throw new Error("Expected a coding-tool list");
  const original = [...tools];
  tools.splice(0, tools.length, "CALLER_MUTATION");

  const second = await availableToolsProvider.get(
    {} as IAgentRuntime,
    {} as Memory,
  );
  expect(second.data?.codingTools).toEqual(original);
});
