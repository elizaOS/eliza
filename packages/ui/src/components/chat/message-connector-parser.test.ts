// Unit tests for the `[CONNECTOR:<id>]` parser (#14412): region extraction,
// name attribute, and the `KEY|required|isSet|label` body schema. Pure module,
// no React graph.

import { describe, expect, it } from "vitest";

import {
  findConnectorRegions,
  parseConnectorBody,
} from "./message-connector-parser";

describe("parseConnectorBody", () => {
  it("parses KEY|required|isSet|label tuples", () => {
    const params = parseConnectorBody(
      "DISCORD_TOKEN|1|0|Bot Token\nDISCORD_GUILD_ID|0|1|Guild ID",
    );
    expect(params).toEqual([
      {
        key: "DISCORD_TOKEN",
        required: true,
        isSet: false,
        label: "Bot Token",
      },
      {
        key: "DISCORD_GUILD_ID",
        required: false,
        isSet: true,
        label: "Guild ID",
      },
    ]);
  });

  it("skips blank lines and drops keyless rows", () => {
    expect(parseConnectorBody("\n|1|0|nope\nTOKEN|1|0|\n")).toEqual([
      { key: "TOKEN", required: true, isSet: false },
    ]);
  });
});

describe("findConnectorRegions", () => {
  it("extracts id, name, params, and char bounds", () => {
    const text =
      'before [CONNECTOR:discord name="Discord"]\nTOKEN|1|0|Bot Token\n[/CONNECTOR] after';
    const [region] = findConnectorRegions(text);
    expect(region.id).toBe("discord");
    expect(region.name).toBe("Discord");
    expect(region.params).toEqual([
      { key: "TOKEN", required: true, isSet: false, label: "Bot Token" },
    ]);
    expect(text.slice(region.start, region.end)).toContain("[/CONNECTOR]");
  });

  it("falls back to the id when no name attribute is present", () => {
    const [region] = findConnectorRegions(
      "[CONNECTOR:telegram]\nTG_BOT_TOKEN|1|0|\n[/CONNECTOR]",
    );
    expect(region.name).toBe("telegram");
  });

  it("returns no regions for text without a marker", () => {
    expect(findConnectorRegions("just a message")).toEqual([]);
  });
});
