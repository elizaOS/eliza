import { describe, expect, it } from "vitest";
import { validateToolSelectionArgument } from "../src/utils/validation";

const select = (value: unknown, schema: Record<string, unknown>) =>
  validateToolSelectionArgument({ toolArguments: value }, schema);

const shared = {
  $id: "https://fixture.invalid/worker-schema",
  type: "object",
  required: ["value"],
  additionalProperties: false,
};

describe("MCP isolated schema worker lifecycle", () => {
  it.each([
    { name: "implicit", dialect: undefined },
    { name: "draft07", dialect: "http://json-schema.org/draft-07/schema#" },
    { name: "current", dialect: "https://json-schema.org/draft/2020-12/schema" },
  ])(
    "validates $name dialect under the request deadline",
    async ({ dialect }) => {
      const schema = {
        ...shared,
        ...(dialect ? { $schema: dialect } : {}),
        properties: { value: { type: "integer" } },
      };
      expect(await select({ value: 0 }, schema)).toMatchObject({ success: true });
      expect(await select({ value: "zero" }, schema)).toMatchObject({ success: false });
    },
    10_000
  );

  it("isolates identical schema ids in successive workers", async () => {
    expect(
      await select(
        { value: 0 },
        {
          ...shared,
          properties: { value: { type: "integer" } },
        }
      )
    ).toMatchObject({ success: true });
    expect(
      await select(
        { value: "changed" },
        {
          ...shared,
          properties: { value: { type: "string" } },
        }
      )
    ).toMatchObject({ success: true });
  }, 10_000);

  it("retains the request deadline for expensive untrusted validation", async () => {
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 10);
    try {
      const result = await select(
        { value: `${"a".repeat(64)}!` },
        {
          ...shared,
          properties: { value: { type: "string", pattern: "^(a+)+$" } },
        }
      );
      expect(result).toEqual({
        success: false,
        error: "Invalid arguments: MCP JSON schema validation exceeded 250ms",
      });
      expect(heartbeats).toBeGreaterThan(0);
    } finally {
      clearInterval(heartbeat);
    }
    expect(await select({}, { type: "object" })).toMatchObject({ success: true });
  }, 10_000);
});
