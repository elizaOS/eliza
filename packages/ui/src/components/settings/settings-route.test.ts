/**
 * Unit tests for structured Settings hash routes (flat sections + nested
 * connectors detail), including real browser-history traversal in jsdom.
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  backFromConnectorDetail,
  isPushedConnectorDetailRoute,
  normalizeConnectorRouteId,
  openConnectorDetailHash,
  parseSettingsHash,
  replaceConnectorDetailHash,
  settingsRouteToHash,
} from "./settings-route";

beforeEach(() => {
  window.history.replaceState(null, "", "/#connectors");
});

function nextPopState(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
}

describe("parseSettingsHash", () => {
  it("parses hub, flat section, and connectors detail", () => {
    expect(parseSettingsHash("")).toEqual({ kind: "hub" });
    expect(parseSettingsHash("#")).toEqual({ kind: "hub" });
    expect(parseSettingsHash("#appearance")).toEqual({
      kind: "section",
      sectionId: "appearance",
    });
    expect(parseSettingsHash("#general")).toEqual({
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

describe("connector detail history", () => {
  it("returns index → detail navigation to the index on browser Back", async () => {
    openConnectorDetailHash("telegram");
    expect(window.location.hash).toBe("#connectors/telegram");

    const popped = nextPopState();
    window.history.back();
    await popped;

    expect(window.location.hash).toBe("#connectors");
  });

  it("consumes detail on visible Back so the next hardware Back leaves index", async () => {
    window.history.replaceState(null, "", "/#appearance");
    window.history.pushState(null, "", "#connectors");
    openConnectorDetailHash("telegram");

    let popped = nextPopState();
    backFromConnectorDetail();
    await popped;
    expect(window.location.hash).toBe("#connectors");

    popped = nextPopState();
    window.history.back();
    await popped;
    expect(window.location.hash).toBe("#appearance");
  });

  it("preserves the pushed marker when programmatic focus replaces detail A with detail B", async () => {
    // [appearance, connectors, detail A] → focus detail B → visible Back →
    // hardware Back must leave connectors (not stall on a replaced index).
    window.history.replaceState(null, "", "/#appearance");
    window.history.pushState(null, "", "#connectors");
    openConnectorDetailHash("telegram");
    expect(window.location.hash).toBe("#connectors/telegram");
    expect(isPushedConnectorDetailRoute()).toBe(true);

    replaceConnectorDetailHash("discord");
    expect(window.location.hash).toBe("#connectors/discord");
    expect(isPushedConnectorDetailRoute()).toBe(true);

    let popped = nextPopState();
    backFromConnectorDetail();
    await popped;
    expect(window.location.hash).toBe("#connectors");

    popped = nextPopState();
    window.history.back();
    await popped;
    expect(window.location.hash).toBe("#appearance");
  });

  it("keeps direct/programmatic detail entry marker-free", () => {
    window.history.replaceState(null, "", "/#connectors");
    replaceConnectorDetailHash("telegram");
    expect(window.location.hash).toBe("#connectors/telegram");
    expect(isPushedConnectorDetailRoute()).toBe(false);

    backFromConnectorDetail();
    expect(window.location.hash).toBe("#connectors");
  });
});

describe("normalizeConnectorRouteId", () => {
  it("lower-cases and aliases twitter", () => {
    expect(normalizeConnectorRouteId(" Discord ")).toBe("discord");
    expect(normalizeConnectorRouteId("twitter")).toBe("x");
  });
});
