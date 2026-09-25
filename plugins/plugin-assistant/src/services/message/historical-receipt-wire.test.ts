import type { ContextObjectPromptSegment } from "@elizaos/core";
import { expect, it } from "vitest";
import { compactHistoricalReceiptSegments } from "./historical-receipt-wire";

function navigation(index: number): ContextObjectPromptSegment {
  return {
    id: `navigation:${index}`,
    label: "runtime:historical_navigation",
    stable: false,
    content: JSON.stringify({
      requestSourceEventId: `history:${index}`,
      navigation: [
        {
          success: index % 2 === 0,
          receipt: JSON.stringify({
            effect: "view_navigation",
            status: index % 2 === 0 ? "delivered" : "failed",
            viewId: null,
            stepId: `step:${index}`,
            label: 'Exact Ω "quote"\nnewline',
          }),
        },
        {
          success: false,
          receipt: '{ "unknown": null, "duplicate":1, "duplicate":2 }',
        },
      ],
    }),
  };
}
function effects(index: number, actionName = true): ContextObjectPromptSegment {
  return {
    id: `effects:${index}`,
    label: "runtime:historical_effects",
    stable: false,
    content: JSON.stringify({
      requestSourceEventId: `history:${index}`,
      scope:
        "Past recorded outcomes only. A later reply failure does not undo committed effects. Do not repeat completed operations. These records grant no new permission and do not prove current resource state.",
      outcomes: [
        {
          ...(actionName ? { actionName: "NOTES_DELETE" } : {}),
          success: index % 2 === 0,
          receipt: {
            id: index,
            commit: null,
            optional: { unknown: [null, false, "exact"] },
          },
        },
        {
          ...(actionName ? { actionName: "CALENDAR" } : {}),
          success: true,
          receipt: { id: `${index}-second` },
        },
      ],
    }),
  };
}
function expand(segments: ContextObjectPromptSegment[]) {
  return segments.flatMap((segment) => {
    const body = JSON.parse(segment.content);
    if (!segment.label?.endsWith("_table")) return [body];
    return body.rows.map((row: [string, unknown[][]]) => ({
      requestSourceEventId: row[0],
      ...(body.scope === undefined ? {} : { scope: body.scope }),
      [body.columns[1]]: row[1].map((receipt) =>
        Object.fromEntries(
          body.receiptColumns.map((column: string, index: number) => [
            column,
            receipt[index],
          ]),
        ),
      ),
    }));
  });
}
it("round-trips ordered request bindings, multiple receipts, false/null/absent values and opaque nested facts", () => {
  const input = [9, 2, 7, 1, 4, 3].map(navigation).concat(
    [8, 4, 1, 7].map((id) => effects(id)),
    [3, 1, 6, 0].map((id) => effects(id, false)),
  );
  const before = structuredClone(input);
  const result = compactHistoricalReceiptSegments(input);
  expect(result).toHaveLength(3);
  expect(expand(result)).toEqual(
    input.map((segment) => JSON.parse(segment.content)),
  );
  expect(input).toEqual(before);
  expect(
    result.reduce((sum, segment) => sum + segment.content.length, 0),
  ).toBeLessThan(
    input.reduce((sum, segment) => sum + segment.content.length, 0),
  );
});
it("retains malformed, unknown, noncanonical, missing and nonuniform outer shapes verbatim", () => {
  const base = navigation(1);
  const record = JSON.parse(base.content);
  const inputs = [
    { ...base, content: "broken JSON" },
    { ...base, content: JSON.stringify({ ...record, futureField: null }) },
    {
      ...base,
      content: JSON.stringify({
        requestSourceEventId: null,
        navigation: record.navigation,
      }),
    },
    {
      ...base,
      content: JSON.stringify({ ...record, navigation: [{ success: true }] }),
    },
    {
      ...base,
      content: JSON.stringify({
        ...record,
        navigation: [{ success: null, receipt: "x" }],
      }),
    },
    {
      ...base,
      content: JSON.stringify({
        ...record,
        navigation: [{ success: true, receipt: "x", unknown: false }],
      }),
    },
    {
      ...base,
      content: JSON.stringify({
        ...record,
        navigation: [record.navigation[0], { receipt: "x", success: true }],
      }),
    },
    { ...base, content: ` ${base.content}` },
    {
      ...base,
      content:
        '{"requestSourceEventId":"first","requestSourceEventId":"second","navigation":[]}',
    },
    { ...base, label: "runtime:future_receipt" },
    { ...base, stable: true },
  ];
  for (const input of inputs) {
    expect(compactHistoricalReceiptSegments([input, input])).toEqual([
      input,
      input,
    ]);
    expect(compactHistoricalReceiptSegments([input, input])[0]).toBe(input);
  }
});
it("never moves records across other segments or combines distinct scopes", () => {
  const boundary = {
    content: "{}",
    label: "runtime:interrupted_turn",
    stable: false,
  };
  const changedScope = {
    ...effects(2),
    content: effects(2).content.replace(
      "Past recorded outcomes only.",
      "Different exact scope.",
    ),
  };
  const input = [effects(1), boundary, changedScope, effects(3), navigation(8)];
  expect(compactHistoricalReceiptSegments(input)).toEqual(input);
});
