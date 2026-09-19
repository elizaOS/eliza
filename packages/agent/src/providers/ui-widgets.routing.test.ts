/** Tests production provider discovery through the real Stage-1 and planner selectors with a deterministic runtime fixture. */
import {
  type AgentContext,
  AgentRuntime,
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createV5MessageContextObject } from "../../../core/src/services/message/context-assembly.ts";
import {
  selectV5PlannerStateProviderNames,
  stage1ResponseStateProviderNames,
} from "../../../core/src/services/message/provider-state.ts";
import { renderMessageHandlerModelInput } from "../../../core/src/services/message/stage1-input.ts";
import {
  uiGenerativeProvider,
  uiWidgetCapabilitiesProvider,
  uiWidgetsProvider,
} from "./ui-catalog.ts";

const runtime = {
  providers: [
    uiWidgetCapabilitiesProvider,
    uiWidgetsProvider,
    uiGenerativeProvider,
  ],
  getSetting: () => undefined,
} as unknown as IAgentRuntime;
const message = {
  content: { text: "show choices", channelType: ChannelType.API },
} as Memory;

describe("production widget provider routing", () => {
  it.each(["MEMBER", "ADMIN"] as const)(
    "keeps generative grammar deferred while advertising only authorized support to %s",
    async (role) => {
      const actual = new AgentRuntime({
        character: { name: "widget-routing" },
      });
      actual.registerProvider(uiGenerativeProvider);
      const turn: Memory = {
        ...message,
        id: "00000000-0000-0000-0000-0000000000a1" as UUID,
        entityId: "00000000-0000-0000-0000-0000000000a2" as UUID,
        roomId: "00000000-0000-0000-0000-0000000000a3" as UUID,
      };
      const stage1 = await actual.composeState(
        turn,
        stage1ResponseStateProviderNames(actual, turn, [role]),
        true,
      );
      const context = await createV5MessageContextObject({
        runtime: actual,
        message: turn,
        state: stage1,
        userRoles: [role],
      });
      const wire = JSON.stringify(
        renderMessageHandlerModelInput(actual, context).messages,
      );
      expect(wire.includes("Rich-reply support is available")).toBe(
        role === "ADMIN",
      );
      expect(wire).not.toContain("Generative UI — inline JSONL patches");
      const planned = await actual.composeState(
        turn,
        selectV5PlannerStateProviderNames({
          runtime: actual,
          message: turn,
          selectedContexts: ["general"],
          userRoles: [role],
        }),
        true,
      );
      expect(
        planned.text.includes("Generative UI — inline JSONL patches"),
      ).toBe(role === "ADMIN");
    },
  );

  it.each(["general", "tasks", "connectors", "settings"] as AgentContext[])(
    "supplies the full guide to the %s planner without another discovery call",
    (context) => {
      const names = selectV5PlannerStateProviderNames({
        runtime,
        message,
        selectedContexts: [context],
        userRoles: ["MEMBER"],
      });
      expect(names).toContain("uiWidgets");
    },
  );

  it("keeps the full guide out of simple and unrelated document contexts", () => {
    for (const context of ["simple", "documents"] as AgentContext[]) {
      const names = selectV5PlannerStateProviderNames({
        runtime,
        message,
        selectedContexts: [context],
        userRoles: ["MEMBER"],
      });
      expect(names).not.toContain("uiWidgets");
    }
  });
});
