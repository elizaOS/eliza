/**
 * Unit tests for connector card parser: validates [CONNECTOR:pluginId] extraction.
 */
import { describe, expect, it } from "vitest";
import { findConnectorCardRegions } from "./message-connector-parser.ts";

describe("message-connector-parser", () => {
  it("returns empty array when text contains no connector markers", () => {
    expect(findConnectorCardRegions("Hello world, no markers here!")).toEqual(
      [],
    );
  });

  it("extracts single connector card region and pluginId", () => {
    const text = "Please authorize Twitter: [CONNECTOR:twitter] to proceed.";
    const regions = findConnectorCardRegions(text);
    expect(regions.length).toBe(1);
    expect(regions[0].pluginId).toBe("twitter");
    expect(regions[0].start).toBe(text.indexOf("[CONNECTOR:twitter]"));
    expect(regions[0].end).toBe(
      text.indexOf("[CONNECTOR:twitter]") + "[CONNECTOR:twitter]".length,
    );
  });

  it("extracts scoped package connector IDs correctly", () => {
    const text = "[CONNECTOR:@elizaos/plugin-discord]";
    const regions = findConnectorCardRegions(text);
    expect(regions.length).toBe(1);
    expect(regions[0].pluginId).toBe("@elizaos/plugin-discord");
  });

  it("extracts connector card region with whitespace inside tag brackets", () => {
    const text = "Authorize here: [  CONNECTOR:twitter  ] to continue.";
    const regions = findConnectorCardRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].pluginId).toBe("twitter");
  });

  it("extracts connector card region with whitespace around separator colon", () => {
    const text = "[ CONNECTOR : @elizaos/plugin-discord ]";
    const regions = findConnectorCardRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].pluginId).toBe("@elizaos/plugin-discord");
  });
});
