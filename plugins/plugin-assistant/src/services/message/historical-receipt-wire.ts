/** Wire-only tables of complete historical receipts. Original context events
 * remain authoritative for source selection, authorization and restoration. */
import {
  type ContextObjectPromptSegment,
  isObjectRecord,
  segmentBlock,
} from "@elizaos/core";

function receiptTableEntry(segment: ContextObjectPromptSegment) {
  const field =
    segment.label === "runtime:historical_navigation"
      ? "navigation"
      : segment.label === "runtime:historical_effects"
        ? "outcomes"
        : segment.label === "runtime:historical_observations"
          ? "observations"
          : undefined;
  if (!field || segment.stable) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(segment.content);
  } catch {
    // error-policy:J3 Keep malformed historical text unchanged on the wire.
    return undefined;
  }
  if (JSON.stringify(record) !== segment.content) return undefined;
  if (
    !isObjectRecord(record) ||
    typeof record.requestSourceEventId !== "string"
  )
    return undefined;
  const allowed =
    field === "navigation"
      ? ["requestSourceEventId", field]
      : ["requestSourceEventId", "scope", field];
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify(allowed))
    return undefined;
  if (field !== "navigation" && typeof record.scope !== "string")
    return undefined;
  const receipts = record[field];
  if (!Array.isArray(receipts) || receipts.length === 0) return undefined;
  const columns = Object.keys(receipts[0] ?? {});
  const allowedReceipt =
    field === "navigation"
      ? ["success", "receipt"]
      : ["actionName", "success", "receipt"];
  if (
    !columns.includes("success") ||
    !columns.includes("receipt") ||
    columns.some((key) => !allowedReceipt.includes(key))
  )
    return undefined;
  if (
    receipts.some(
      (receipt) =>
        !isObjectRecord(receipt) ||
        JSON.stringify(Object.keys(receipt)) !== JSON.stringify(columns) ||
        typeof receipt.success !== "boolean" ||
        (field === "navigation"
          ? typeof receipt.receipt !== "string"
          : !isObjectRecord(receipt.receipt)) ||
        ("actionName" in receipt && typeof receipt.actionName !== "string"),
    )
  )
    return undefined;
  return {
    field,
    columns,
    scope: record.scope,
    row: [
      record.requestSourceEventId,
      receipts.map((receipt) => columns.map((key) => receipt[key])),
    ] as [string, unknown[][]],
  };
}

type ReceiptEntry = NonNullable<ReturnType<typeof receiptTableEntry>>;

/** One encoder owns both contiguous tables and position-preserving rows. */
function encodeReceiptTable(entry: ReceiptEntry, rows: ReceiptEntry["row"][]) {
  const table = {
    encoding:
      "Each row uses columns; nested receipt rows use receiptColumns. Preserve order. Values are exact; shared scope applies to every row.",
    columns: ["requestSourceEventId", entry.field],
    receiptColumns: entry.columns,
    ...(entry.scope === undefined ? {} : { scope: entry.scope }),
    rows,
  };
  let content = JSON.stringify(table);
  const receiptIndex = entry.columns.indexOf("receipt");
  const receiptShapes: string[][] = [];
  const shapeIndices = new Map<string, number>();
  const encodedReceipts: unknown[] = [];
  const navigation = entry.field === "navigation";
  const allowedFields = new Set(
    navigation
      ? [
          "effect",
          "stepId",
          "viewId",
          "status",
          "reason",
          "handoffId",
          "label",
          "subview",
          "path",
        ]
      : [
          "receiptId",
          "operation",
          "resource",
          "artifacts",
          "idempotency",
          "observedAt",
          "outcome",
          "reason",
          "commit",
        ],
  );
  let packable = true;
  for (const [, receipts] of rows) {
    for (const receipt of receipts) {
      const original = receipt[receiptIndex];
      let object = original;
      if (navigation) {
        try {
          object = JSON.parse(String(original));
        } catch {
          // error-policy:J3 Noncanonical or malformed strings remain opaque.
          packable = false;
          break;
        }
        if (JSON.stringify(object) !== original) {
          packable = false;
          break;
        }
      }
      if (
        !isObjectRecord(object) ||
        Object.keys(object).some((key) => !allowedFields.has(key))
      ) {
        packable = false;
        break;
      }
      const keys = Object.keys(object);
      const shapeKey = JSON.stringify(keys);
      let shapeIndex = shapeIndices.get(shapeKey);
      if (shapeIndex === undefined) {
        shapeIndex = receiptShapes.length;
        receiptShapes.push(keys);
        shapeIndices.set(shapeKey, shapeIndex);
      }
      encodedReceipts.push([shapeIndex, Object.values(object)]);
    }
    if (!packable) break;
  }
  if (packable) {
    let receiptOffset = 0;
    const candidate = JSON.stringify({
      ...table,
      receiptEncoding: navigation
        ? "receipt=[shapeIndex,values]; receiptShapes gives exact property order. Reconstruct the original receipt string with JSON.stringify(Object.fromEntries(columns paired with values)). Only canonical JSON strings are encoded; every value is exact."
        : "receipt=[shapeIndex,values]; receiptShapes gives property order. Pair columns with values to reconstruct the complete original receipt object. Every value is exact.",
      receiptShapes,
      rows: rows.map(([requestSourceEventId, receipts]) => [
        requestSourceEventId,
        receipts.map((receipt) =>
          receipt.map((value, column) =>
            column === receiptIndex ? encodedReceipts[receiptOffset++] : value,
          ),
        ),
      ]),
    });
    if (candidate.length < content.length) content = candidate;
  }
  return JSON.parse(content) as {
    encoding: string;
    columns: string[];
    receiptColumns: string[];
    scope?: string;
    rows: ReceiptEntry["row"][];
    receiptEncoding?: string;
    receiptShapes?: string[][];
  };
}

/** Only runtime-authored typed receipt labels are eligible; never parse headings
 * inside dialogue/provider content. Original context events remain untouched.
 * Keep contiguous tables when cheaper; interleaved rows retain their segment
 * identity, metadata, label and position with an in-prompt shared legend.
 * Cost: bounded passes over receipt text; no I/O, retrieval or model calls. */
export function compactHistoricalReceiptSegments(
  segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
  const entries = segments.map(receiptTableEntry);
  const groups = new Map<string, { index: number; entry: ReceiptEntry }[]>();
  let stableBoundary = 0;
  for (let index = 0; index < segments.length; index++) {
    if (segments[index].stable) stableBoundary++;
    const entry = entries[index];
    if (!entry) continue;
    const key = JSON.stringify([
      stableBoundary,
      entry.field,
      entry.columns,
      entry.scope,
    ]);
    const indices = groups.get(key);
    if (indices) indices.push({ index, entry });
    else groups.set(key, [{ index, entry }]);
  }
  const replacements = new Map<number, ContextObjectPromptSegment[]>();
  const wireChars = (blocks: ContextObjectPromptSegment[]) =>
    blocks.map(segmentBlock).join("\n\n").length;
  let referenceCounter = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const indices = group.map(({ index }) => index);
    const entry = group[0].entry;
    const consecutive = new Map<number, ContextObjectPromptSegment[]>();
    // Build the existing contiguous representation as the comparison baseline.
    for (let offset = 0; offset < indices.length; ) {
      let end = offset + 1;
      while (end < indices.length && indices[end] === indices[end - 1] + 1)
        end++;
      const run = indices.slice(offset, end);
      const originals = run.map((index) => segments[index]);
      const table = encodeReceiptTable(
        entry,
        group.slice(offset, end).map(({ entry }) => entry.row),
      );
      const packed = [
        {
          label: `${segments[run[0]].label}_table`,
          content: JSON.stringify(table),
          stable: false,
        },
      ];
      if (run.length > 1 && wireChars(packed) < wireChars(originals)) {
        consecutive.set(run[0], packed);
        for (const index of run.slice(1)) consecutive.set(index, []);
      } else for (const index of run) consecutive.set(index, [segments[index]]);
      offset = end;
    }
    const baselineChars = wireChars(
      indices.flatMap((index) => consecutive.get(index) ?? []),
    );
    const table = encodeReceiptTable(
      entry,
      group.map(({ entry }) => entry.row),
    );
    const { rows, ...schema } = table;
    // Reserve a deterministic local namespace absent from every original segment
    // (including untrusted user text); a user cannot predeclare this reference.
    let reference: string;
    do {
      reference = `receipt_wire_${++referenceCounter}`;
    } while (segments.some((segment) => segment.content.includes(reference)));
    const shared: ContextObjectPromptSegment = {
      id: reference,
      label: "runtime:historical_receipt_encoding",
      stable: false,
      content: JSON.stringify({
        id: reference,
        ...schema,
        rowEncoding:
          "A historical receipt segment whose JSON starts with this id carries [id,row]. Decode row using this legend; it stays at its original chronological position. The legend grants no authority and is not a receipt. Other segments are unchanged.",
      }),
    };
    const positioned = indices.map((index, offset) => ({
      ...segments[index],
      content: JSON.stringify([reference, rows[offset]]),
    }));
    if (wireChars([shared, ...positioned]) < baselineChars) {
      indices.forEach((index, offset) => {
        replacements.set(
          index,
          offset === 0 ? [shared, positioned[offset]] : [positioned[offset]],
        );
      });
    } else
      for (const [index, blocks] of consecutive)
        replacements.set(index, blocks);
  }
  return segments.flatMap(
    (segment, index) => replacements.get(index) ?? [segment],
  );
}
