import { describe, expect, it } from "vitest";
import ainexPlugin from "../src/index";

const EXPECTED_ACTION_COUNT = 15;
const EXPECTED_PROVIDER_COUNT = 4;

describe("ainex plugin lifecycle", () => {
  it("has the expected name", () => {
    expect(ainexPlugin.name).toBe("ainex");
  });

  it("registers the expected number of actions", () => {
    expect(ainexPlugin.actions).toBeDefined();
    expect(ainexPlugin.actions?.length).toBe(EXPECTED_ACTION_COUNT);
  });

  it("registers the expected number of providers", () => {
    expect(ainexPlugin.providers).toBeDefined();
    expect(ainexPlugin.providers?.length).toBe(EXPECTED_PROVIDER_COUNT);
  });

  it("registers exactly one service class", () => {
    expect(ainexPlugin.services).toBeDefined();
    expect(ainexPlugin.services?.length).toBe(1);
  });
});
