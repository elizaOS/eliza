import { describe, expect, it } from "vitest";

import {
  expandConnectorSourceFilter,
  getConnectorSourceAliases,
  getConnectorSourceMetadata,
  isPassiveConnectorSource,
  normalizeConnectorSource,
  registerConnectorSourceAliases,
  registerConnectorSourceMetadata,
} from "./connectors";

describe("connector source aliases", () => {
  it("normalizes built-in connector aliases", () => {
    expect(normalizeConnectorSource(" discord-local ")).toBe("discord");
    expect(normalizeConnectorSource("BlueBubbles")).toBe("imessage");
    expect(normalizeConnectorSource("x_dm")).toBe("x");
    expect(getConnectorSourceAliases("telegram")).toEqual([
      "telegram",
      "telegram-account",
      "telegramaccount",
    ]);
  });

  it("expands registered aliases without depending on @elizaos/core", () => {
    registerConnectorSourceAliases("custom", ["CustomAccount"]);

    expect(normalizeConnectorSource("customaccount")).toBe("custom");
    expect([...expandConnectorSourceFilter(["custom"])]).toEqual([
      "customaccount",
    ]);
  });

  it("reads passive connector metadata from built-in and registered sources", () => {
    registerConnectorSourceMetadata("custom-passive", {
      aliases: ["custom-passive-account"],
      sourceKind: "passive",
    });

    expect(getConnectorSourceMetadata("discord-local")).toMatchObject({
      sourceKind: "passive",
      isPassive: true,
    });
    expect(isPassiveConnectorSource("custom-passive-account")).toBe(true);
    expect(isPassiveConnectorSource("unknown-source")).toBe(false);
  });
});
