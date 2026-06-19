import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPlannerView, scoreViewSelection } from "./scoring.js";

const DATASET = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "view-context.jsonl",
);

interface Row {
  format: string;
  boundary: string;
  request: {
    system?: string;
    messages: Array<{ role: string; content: string }>;
  };
  response: { text: string };
}
const ROWS: Row[] = readFileSync(DATASET, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row);

describe("view-context dataset — format", () => {
  it("has a meaningful number of rows", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(20);
  });
  it("every row is a well-formed eliza_native_v1 example with a {viewId} response", () => {
    for (const row of ROWS) {
      expect(row.format).toBe("eliza_native_v1");
      expect(row.boundary).toBe("vercel_ai_sdk.generateText");
      const user = row.request.messages.at(-1);
      expect(user?.role).toBe("user");
      expect((user?.content ?? "").length).toBeGreaterThan(0);
      const parsed = JSON.parse(row.response.text) as Record<string, unknown>;
      expect(typeof parsed.viewId).toBe("string");
    }
  });
  it("contains contextual navigations AND 'none' negatives", () => {
    const views = ROWS.map((r) => extractPlannerView(r.response.text));
    expect(
      views.filter((v) => v && v !== "none").length,
    ).toBeGreaterThanOrEqual(15);
    expect(views.filter((v) => v === "none").length).toBeGreaterThanOrEqual(3);
  });
});

describe("scoreViewSelection", () => {
  it("scores every dataset row 1.0 against its own reference", () => {
    for (const row of ROWS) {
      expect(scoreViewSelection(row.response.text, row.response.text)).toBe(1);
    }
  });
  it("rewards the right view, punishes the wrong view", () => {
    const ref = JSON.stringify({ viewId: "task-coordinator" });
    expect(
      scoreViewSelection(JSON.stringify({ viewId: "task-coordinator" }), ref),
    ).toBe(1);
    expect(
      scoreViewSelection(JSON.stringify({ viewId: "calendar" }), ref),
    ).toBe(0);
  });
  it("rewards a correct 'none' (declining to navigate)", () => {
    const ref = JSON.stringify({ viewId: "none" });
    expect(scoreViewSelection(JSON.stringify({ viewId: "none" }), ref)).toBe(1);
    expect(
      scoreViewSelection(JSON.stringify({ viewId: "calendar" }), ref),
    ).toBe(0);
  });
  it("matches case-insensitively", () => {
    expect(
      scoreViewSelection(
        JSON.stringify({ viewId: "Calendar" }),
        JSON.stringify({ viewId: "calendar" }),
      ),
    ).toBe(1);
  });
});
