/**
 * Unit tests for the content-delivery matrix schema + compiler + coverage
 * gate (#23105 first lane). Harness is deterministic: pure functions, no
 * network, no mocks fleet. Adversarial rows (duplicate ids, unknown fields,
 * wrong schema version, self-pairs, missing proofs) must be rejected — the
 * compiler is the fail-closed inventory the completeness gate relies on.
 */
import { describe, expect, it } from "vitest";
import {
  assertDeliveryCoverage,
  compileContentDeliveryMatrix,
} from "./compiler";
import { FIRST_LANE_DELIVERY_ROWS } from "./registry";
import type { ContentDeliveryMatrixRow } from "./schema";

const validTextRow: ContentDeliveryMatrixRow = FIRST_LANE_DELIVERY_ROWS[0];

function row(
  overrides: Partial<ContentDeliveryMatrixRow>,
): ContentDeliveryMatrixRow {
  return { ...validTextRow, ...overrides };
}

describe("compileContentDeliveryMatrix", () => {
  it("compiles the first-lane registry rows and enumerates them", () => {
    const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
    expect(matrix.schema).toBe(1);
    expect(matrix.rows.map((r) => r.id)).toEqual([
      "discord-to-telegram.text",
      "discord-to-telegram.file",
    ]);
    const textRows = matrix.rowsFor("discord", "telegram", "text");
    expect(textRows).toHaveLength(1);
    expect(textRows[0]?.transformClass).toBe("verbatim-text");
    expect(matrix.rowsFor("telegram", "discord", "text")).toHaveLength(0);
  });

  it("rejects an empty matrix — no rows certifies nothing", () => {
    expect(() => compileContentDeliveryMatrix([])).toThrow(/must not be empty/);
  });

  it("rejects a duplicate row id", () => {
    expect(() =>
      compileContentDeliveryMatrix([validTextRow, validTextRow]),
    ).toThrow(/duplicate row id/);
  });

  it("rejects an unknown field on a row", () => {
    const extra = {
      ...validTextRow,
      bonus: "not allowed",
    } as unknown;
    expect(() => compileContentDeliveryMatrix([extra])).toThrow(
      /unknown field\(s\): bonus/,
    );
  });

  it("rejects a row with the wrong schema version", () => {
    expect(() =>
      compileContentDeliveryMatrix([row({ schema: 2 as never })]),
    ).toThrow(/schema must be 1/);
  });

  it("rejects an unknown connector, content kind, and transform class", () => {
    expect(() =>
      compileContentDeliveryMatrix([
        row({ sourceConnector: "slack" as never }),
      ]),
    ).toThrow(/sourceConnector must be one of/);
    expect(() =>
      compileContentDeliveryMatrix([row({ contentKind: "sticker" as never })]),
    ).toThrow(/contentKind must be one of/);
    expect(() =>
      compileContentDeliveryMatrix([row({ transformClass: "lossy" as never })]),
    ).toThrow(/transformClass must be one of/);
  });

  it("rejects a self-pair row (source equals target)", () => {
    expect(() =>
      compileContentDeliveryMatrix([
        row({ targetConnector: "discord" as never }),
      ]),
    ).toThrow(/sourceConnector and targetConnector must differ/);
  });

  it("rejects byte-preserving-file rows missing the byte-hash proof", () => {
    const fileRow = FIRST_LANE_DELIVERY_ROWS[1];
    expect(
      fileRow &&
        fileRow.contentKind === "file" &&
        fileRow.transformClass === "byte-preserving-file",
    ).toBe(true);
    expect(() =>
      compileContentDeliveryMatrix([
        row({
          id: "x.file",
          contentKind: "file",
          transformClass: "byte-preserving-file",
          requiredProofs: ["provider-receipt"],
        }),
      ]),
    ).toThrow(/byte-preserving-file rows require the byte-hash proof/);
  });

  it("rejects verbatim-text rows missing the provider-receipt proof", () => {
    expect(() =>
      compileContentDeliveryMatrix([row({ requiredProofs: ["byte-hash"] })]),
    ).toThrow(/verbatim-text rows require the provider-receipt proof/);
  });

  it("freezes rows and the compiled matrix against mutation", () => {
    const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
    expect(() => {
      (matrix.rows as unknown as { push: (v: unknown) => void }).push(
        validTextRow,
      );
    }).toThrow();
    expect(() => {
      (matrix.rows[0] as unknown as Record<string, unknown>).id = "mutated";
    }).toThrow();
  });
});

describe("assertDeliveryCoverage (fail-closed completeness gate)", () => {
  it("passes when every declared capability has a covering row", () => {
    const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
    expect(() =>
      assertDeliveryCoverage(
        [
          {
            sourceConnector: "discord",
            targetConnector: "telegram",
            contentKind: "text",
          },
          {
            sourceConnector: "discord",
            targetConnector: "telegram",
            contentKind: "file",
          },
        ],
        matrix,
      ),
    ).not.toThrow();
  });

  it("RED control: rejects a declared capability with no covering row", () => {
    const matrix = compileContentDeliveryMatrix([
      FIRST_LANE_DELIVERY_ROWS[0], // text row only
    ]);
    expect(() =>
      assertDeliveryCoverage(
        [
          {
            sourceConnector: "discord",
            targetConnector: "telegram",
            contentKind: "text",
          },
          {
            sourceConnector: "discord",
            targetConnector: "telegram",
            contentKind: "file",
          },
        ],
        matrix,
      ),
    ).toThrow(/completeness gate failed.*discord->telegram\.file/);
  });

  it("rejects a declared capability for an uncovered direction", () => {
    const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
    expect(() =>
      assertDeliveryCoverage(
        [
          {
            sourceConnector: "telegram",
            targetConnector: "discord",
            contentKind: "text",
          },
        ],
        matrix,
      ),
    ).toThrow(/telegram->discord\.text/);
  });
});
