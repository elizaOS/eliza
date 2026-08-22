/** Hosted MCP action visibility tests keep DoorDash checkout behind its safe facade. */

import { describe, expect, test } from "bun:test";
import { shouldRegisterRawMcpTools } from "./tool-visibility";

describe("DoorDash MCP action visibility", () => {
  test("suppresses every raw DoorDash tool action", () => {
    expect(shouldRegisterRawMcpTools("doordash")).toBe(false);
    expect(shouldRegisterRawMcpTools(" DoorDash ")).toBe(false);
  });

  test("does not affect other MCP providers", () => {
    expect(shouldRegisterRawMcpTools("github")).toBe(true);
  });
});
