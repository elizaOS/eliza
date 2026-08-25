/**
 * Unit tests for ERC-8004 identity data URI builder and parser.
 */
import { describe, expect, it } from "vitest";
import {
  type AgentRegistrationFile,
  buildDataURI,
  parseDataURI,
} from "../erc8004.js";

describe("ERC-8004 parseDataURI", () => {
  it("round-trips valid registration file through data URI", () => {
    const original: AgentRegistrationFile = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "TestAgent",
      description: "A test agent for ERC-8004",
      image: "https://example.com/agent.png",
      services: [],
      active: true,
      registrant: "0x1234567890123456789012345678901234567890",
    };

    const uri = buildDataURI(original);
    const parsed = parseDataURI(uri);

    expect(parsed.name).toBe("TestAgent");
    expect(parsed.description).toBe("A test agent for ERC-8004");
  });

  it("parses valid inline JSON payload", () => {
    const inlineJson = JSON.stringify({
      name: "InlineAgent",
      description: "Direct inline JSON",
      services: [],
      active: true,
      registrant: "0x1234567890123456789012345678901234567890",
    });

    const parsed = parseDataURI(inlineJson);
    expect(parsed.name).toBe("InlineAgent");
  });

  it("throws descriptive error on malformed base64 data URI payload", () => {
    const malformedDataUri =
      "data:application/json;base64,invalid-base64-payload!!!";
    expect(() => parseDataURI(malformedDataUri)).toThrowError(
      /parseDataURI: Invalid base64 JSON payload/,
    );
  });

  it("throws descriptive error on malformed inline JSON", () => {
    const malformedInline = "{ invalid json without closing quote: 123";
    expect(() => parseDataURI(malformedInline)).toThrowError(
      /parseDataURI: Invalid inline JSON payload/,
    );
  });

  it("throws on unsupported URI scheme", () => {
    expect(() => parseDataURI("ftp://invalid.uri")).toThrowError(
      /parseDataURI: Cannot parse URI scheme/,
    );
  });
});
