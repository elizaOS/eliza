/**
 * Unit tests for the connector-source alias registry
 * (normalizeConnectorSource plus the register/expand/metadata helpers): alias
 * normalization, filter expansion, and passive-source metadata lookup against
 * runtime-registered declarations.
 */
import { describe, expect, it } from "vitest";

import {
  expandConnectorSourceFilter,
  getConnectorSourceAliases,
  getConnectorSourceMetadata,
  isPassiveConnectorSource,
  normalizeConnectorSource,
  registerConnectorSourceAliases,
  registerConnectorSourceDefinitions,
  registerConnectorSourceMetadata,
  unregisterConnectorSourceMetadataOwner,
} from "./connectors";

describe("connector source aliases", () => {
  it("normalizes connector aliases from registered declarations", () => {
    registerConnectorSourceDefinitions(
      [
        {
          source: "primary-chat",
          aliases: ["primary-chat", "primary-chat-account"],
          sourceKind: "passive",
          isPassive: true,
        },
        {
          source: "bridge-chat",
          aliases: ["bridge-chat", "bridge-chat-account"],
          sourceKind: "passive",
          isPassive: true,
        },
        {
          source: "mobile-chat",
          aliases: ["mobile-chat", "mobile-chat-account", "mobilechat"],
          sourceKind: "passive",
          isPassive: true,
        },
        {
          source: "dm-chat",
          aliases: ["dm-chat", "dm-chat-account"],
          sourceKind: "passive",
          isPassive: true,
        },
      ],
      "shared-connectors-test",
    );

    expect(normalizeConnectorSource(" primary-chat-account ")).toBe(
      "primary-chat",
    );
    expect(normalizeConnectorSource("Bridge-Chat-Account")).toBe("bridge-chat");
    expect(normalizeConnectorSource("dm-chat-account")).toBe("dm-chat");
    expect(getConnectorSourceAliases("mobile-chat")).toEqual([
      "mobile-chat",
      "mobile-chat-account",
      "mobilechat",
    ]);

    unregisterConnectorSourceMetadataOwner("shared-connectors-test");
  });

  it("expands registered aliases through the shared compatibility export", () => {
    registerConnectorSourceAliases("custom", ["CustomAccount"]);

    expect(normalizeConnectorSource("customaccount")).toBe("custom");
    expect([...expandConnectorSourceFilter(["custom"])]).toEqual([
      "custom",
      "customaccount",
    ]);
  });

  it("reads passive connector metadata from registered sources", () => {
    registerConnectorSourceMetadata("custom-passive", {
      aliases: ["custom-passive-account"],
      sourceKind: "passive",
    });

    expect(isPassiveConnectorSource("custom-passive-account")).toBe(true);
    expect(isPassiveConnectorSource("unknown-source")).toBe(false);
    expect(getConnectorSourceMetadata("custom-passive-account")).toMatchObject({
      sourceKind: "passive",
    });
  });
});
