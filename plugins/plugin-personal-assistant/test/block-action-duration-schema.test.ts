/**
 * BLOCK's parameter descriptions are the model's instructions. A description
 * that asks for `null` on a schema that rejects null makes core tool-argument
 * validation fail the call the model was told to make ("Argument
 * 'durationMinutes' expected number, got null"). Indefinite blocks are
 * expressed by omitting `durationMinutes`.
 */

import {
  type Action,
  promoteSubactionsToActions,
  validateToolArgs,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { blockAction } from "../src/actions/block";

function schemaAdmitsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (record.type === "null") return true;
  if (Array.isArray(record.type) && record.type.includes("null")) return true;
  return ["anyOf", "oneOf"].some(
    (keyword) =>
      Array.isArray(record[keyword]) &&
      (record[keyword] as unknown[]).some(schemaAdmitsNull),
  );
}

const actions: Action[] = [
  blockAction,
  ...promoteSubactionsToActions(blockAction),
];

describe("BLOCK parameter contract", () => {
  it("never tells the model to send null where the schema rejects it", () => {
    const offending = actions.flatMap((action) =>
      (action.parameters ?? [])
        .filter(
          (parameter) =>
            /\bnull\b/i.test(parameter.description ?? "") &&
            !schemaAdmitsNull(parameter.schema),
        )
        .map((parameter) => `${action.name}.${parameter.name}`),
    );
    expect(offending).toEqual([]);
  });

  it("expresses an indefinite block by omitting durationMinutes", () => {
    const blockBlock = actions.find((action) => action.name === "BLOCK_BLOCK");
    expect(blockBlock).toBeDefined();
    if (!blockBlock) return;
    expect(
      validateToolArgs(blockBlock, {
        target: "website",
        hostnames: ["example.com"],
      }).valid,
    ).toBe(true);
    expect(
      validateToolArgs(blockBlock, {
        target: "website",
        hostnames: ["example.com"],
        durationMinutes: 30,
      }).valid,
    ).toBe(true);
    expect(
      validateToolArgs(blockBlock, {
        target: "website",
        hostnames: ["example.com"],
        durationMinutes: "x",
      }).valid,
    ).toBe(false);
  });
});
