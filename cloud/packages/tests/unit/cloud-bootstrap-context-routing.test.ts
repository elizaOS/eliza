import { describe, expect, test } from "bun:test";
import {
  attachAvailableContexts,
  filterActionsByRouting,
  getContextRoutingFromMessage,
  parseContextList,
  parseContextRoutingMetadata,
  setContextRoutingMetadata,
} from "@/lib/eliza/plugin-cloud-bootstrap/utils/context-routing";

describe("cloud bootstrap context routing", () => {
  test("parses routing metadata with shared contexts only", () => {
    const parsed = parseContextRoutingMetadata({
      primaryContext: "wallet",
      secondaryContexts: "wallet, knowledge, wallet",
      evidenceTurnIds: "turn-1,turn-2,turn-1",
    });

    expect(parsed).toEqual({
      primaryContext: "wallet",
      secondaryContexts: ["wallet", "knowledge"],
    });
  });

  test("stores and retrieves routing metadata on the message content", () => {
    const message = {
      content: {
        text: "check my balance",
      },
    } as never;

    setContextRoutingMetadata(message, {
      primaryContext: "wallet",
      secondaryContexts: ["knowledge"],
    });

    expect(getContextRoutingFromMessage(message)).toEqual({
      primaryContext: "wallet",
      secondaryContexts: ["knowledge"],
    });
  });

  test("derives available contexts from action catalog fallbacks only", () => {
    const nextState = attachAvailableContexts({ values: {}, data: {}, text: "" } as never, {
      actions: [{ name: "SEND_TOKEN" }] as never,
      providers: [{ name: "knowledge" }, { name: "pluginList" }] as never,
    });

    expect(nextState.values.availableContexts).toContain("general");
    expect(nextState.values.availableContexts).toContain("wallet");
    expect(nextState.values.availableContexts).not.toContain("knowledge");
    expect(nextState.values.availableContexts).not.toContain("system");
  });

  test("filters actions to the active routed contexts", () => {
    const filtered = filterActionsByRouting(
      [{ name: "SEND_TOKEN" }, { name: "WEB_SEARCH" }, { name: "MANAGE_PLUGINS" }] as never,
      {
        primaryContext: "wallet",
        secondaryContexts: ["knowledge"],
      },
    );

    expect(filtered.map((action) => action.name)).toEqual(["SEND_TOKEN", "WEB_SEARCH"]);
  });

  test("parses mixed context list inputs and ignores invalid entries", () => {
    expect(
      parseContextList(["wallet;automation", "Knowledge", "wallet", "not-a-context", 123]),
    ).toEqual(["wallet", "automation", "knowledge"]);
  });

  test("returns all actions when routing stays in the general context", () => {
    const filtered = filterActionsByRouting(
      [{ name: "SEND_TOKEN" }, { name: "WEB_SEARCH" }, { name: "MANAGE_PLUGINS" }] as never,
      {},
    );

    expect(filtered.map((action) => action.name)).toEqual([
      "SEND_TOKEN",
      "WEB_SEARCH",
      "MANAGE_PLUGINS",
    ]);
  });

  test("prefers declared action contexts over catalog fallbacks", () => {
    const filtered = filterActionsByRouting(
      [{ name: "SEND_TOKEN", contexts: ["knowledge"] }, { name: "WEB_SEARCH" }] as never,
      {
        primaryContext: "wallet",
      },
    );

    expect(filtered.map((action) => action.name)).toEqual([]);
  });

  test("attaches sorted contexts without discarding existing state values", () => {
    const nextState = attachAvailableContexts(
      {
        values: { retained: "yes" },
        data: {},
        text: "",
      } as never,
      {
        actions: [{ name: "WEB_SEARCH" }, { name: "SEND_TOKEN" }] as never,
        providers: [{ name: "knowledge" }] as never,
      },
    );

    expect(nextState.values.retained).toBe("yes");
    expect(nextState.values.availableContexts).toBe("browser, general, knowledge, wallet");
  });
});
