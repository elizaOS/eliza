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
      secondaryContexts: "wallet, documents, wallet",
    });

    expect(parsed).toEqual({
      primaryContext: "wallet",
      secondaryContexts: ["documents"],
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
      secondaryContexts: ["documents"],
    });

    expect(getContextRoutingFromMessage(message)).toEqual({
      primaryContext: "wallet",
      secondaryContexts: ["documents"],
    });
  });

  test("derives available contexts from action catalog fallbacks only", () => {
    const nextState = attachAvailableContexts({ values: {}, data: {}, text: "" } as never, {
      actions: [{ name: "SEND_TOKEN" }] as never,
      providers: [{ name: "documents" }, { name: "pluginList" }] as never,
    });

    expect(nextState.values.availableContexts).toContain("general");
    expect(nextState.values.availableContexts).toContain("wallet");
    expect(nextState.values.availableContexts).not.toContain("documents");
    expect(nextState.values.availableContexts).not.toContain("system");
  });

  test("filters actions to the active routed contexts", () => {
    const filtered = filterActionsByRouting(
      [{ name: "SEND_TOKEN" }, { name: "WEB_SEARCH" }, { name: "MANAGE_PLUGINS" }] as never,
      {
        primaryContext: "wallet",
        secondaryContexts: ["documents"],
      },
    );

    expect(filtered.map((action) => action.name)).toEqual(["SEND_TOKEN", "WEB_SEARCH"]);
  });

  test("parses mixed context list inputs and ignores invalid entries", () => {
    expect(
      parseContextList(["wallet;automation", "Documents", "wallet", "not-a-context", 123]),
    ).toEqual(["wallet", "automation", "documents"]);
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
      [{ name: "SEND_TOKEN", contexts: ["documents"] }, { name: "WEB_SEARCH" }] as never,
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
        providers: [{ name: "documents" }] as never,
      },
    );

    expect(nextState.values.retained).toBe("yes");
    expect(nextState.values.availableContexts).toBe("browser, documents, general, wallet");
  });
});
