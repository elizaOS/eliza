/**
 * Unit tests for structured Settings hash routes (flat sections + nested
 * connectors detail). Deterministic pure parsing — no registry dependency.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeConnectorRouteId,
  parseSettingsHash,
  settingsRouteToHash,
} from "./settings-route";

describe("parseSettingsHash", () => {
  it("parses hub, flat section, and connectors detail", () => {
    expect(parseSettingsHash("")).toEqual({ kind: "hub" });
    expect(parseSettingsHash("#")).toEqual({ kind: "hub" });
    expect(parseSettingsHash("#appearance")).toEqual({
      kind: "section",
      sectionId: "appearance",
    });
    expect(parseSettingsHash("#connectors")).toEqual({
      kind: "section",
      sectionId: "connectors",
    });
    expect(parseSettingsHash("#connectors/discord")).toEqual({
      kind: "connector-detail",
      sectionId: "connectors",
      connectorId: "discord",
    });
  });

  it("applies billing/api-keys aliases and twitter→x on connector ids", () => {
    expect(parseSettingsHash("#billing")).toEqual({
      kind: "section",
      sectionId: "cloud-billing",
    });
    expect(parseSettingsHash("#connectors/Twitter")).toEqual({
      kind: "connector-detail",
      sectionId: "connectors",
      connectorId: "x",
    });
  });

  it("collapses illegal nesting under non-connectors sections to the section", () => {
    expect(parseSettingsHash("#appearance/theme")).toEqual({
      kind: "section",
      sectionId: "appearance",
    });
  });
});

describe("settingsRouteToHash", () => {
  it("round-trips connector detail", () => {
    expect(
      settingsRouteToHash({
        kind: "connector-detail",
        sectionId: "connectors",
        connectorId: "telegram",
      }),
    ).toBe("#connectors/telegram");
  });
});

describe("normalizeConnectorRouteId", () => {
  it("lower-cases and aliases twitter", () => {
    expect(normalizeConnectorRouteId(" Discord ")).toBe("discord");
    expect(normalizeConnectorRouteId("twitter")).toBe("x");
  });
});
