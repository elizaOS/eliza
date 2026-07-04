import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPlannerAction,
  extractPlannerView,
  scorePlannerAction,
} from "./scoring.js";

// Wires the view-switching action_planner eval dataset into the test graph:
// every row must be a valid eliza_native_v1 planner example, and the view-aware
// scorer must read it.

const DATASET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "view-switching.action_planner.jsonl",
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

function loadRows(): Row[] {
  return readFileSync(DATASET_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

const ROWS = loadRows();

describe("view-switching eval dataset — format", () => {
  it("has a meaningful number of rows", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(20);
  });

  it("every row is a well-formed eliza_native_v1 generateText example", () => {
    for (const row of ROWS) {
      expect(row.format).toBe("eliza_native_v1");
      expect(row.boundary).toBe("vercel_ai_sdk.generateText");
      expect(row.request.messages.length).toBeGreaterThan(0);
      const user = row.request.messages.at(-1);
      expect(user?.role).toBe("user");
      expect(typeof user?.content).toBe("string");
      expect(user?.content.length).toBeGreaterThan(0);
      // response.text must itself be the planner tool-call JSON shape.
      const parsed = JSON.parse(row.response.text) as Record<string, unknown>;
      expect(typeof parsed.action).toBe("string");
    }
  });

  it("covers multiple languages (es / fr / de / zh)", () => {
    const users = ROWS.map((r) => r.request.messages.at(-1)?.content ?? "");
    expect(users.some((u) => /muéstrame|revisa|gastado/i.test(u))).toBe(true); // es
    expect(users.some((u) => /montre-moi|ouvre|tâches/i.test(u))).toBe(true); // fr
    expect(users.some((u) => /zeig mir|kalender/i.test(u))).toBe(true); // de
    expect(users.some((u) => /我的|待办/.test(u))).toBe(true); // zh
  });

  it("contains both VIEWS navigations and REPLY negatives", () => {
    const actions = ROWS.map((r) => extractPlannerAction(r.response.text));
    expect(actions.filter((a) => a === "VIEWS").length).toBeGreaterThanOrEqual(
      15,
    );
    expect(actions.filter((a) => a === "REPLY").length).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("view-switching eval dataset — scorer reads it", () => {
  it("scores every row 1.0 against its own reference (self-consistency)", () => {
    for (const row of ROWS) {
      expect(scorePlannerAction(row.response.text, row.response.text)).toBe(1);
    }
  });

  it("every VIEWS row pins a concrete view id", () => {
    for (const row of ROWS) {
      if (extractPlannerAction(row.response.text) !== "VIEWS") continue;
      const view = extractPlannerView(row.response.text);
      expect(
        view,
        `row "${row.request.messages.at(-1)?.content}"`,
      ).toBeTruthy();
    }
  });

  it("penalizes a wrong-view output (0.5) and a wrong-action output (0) on a VIEWS row", () => {
    const navRow = ROWS.find(
      (r) => extractPlannerAction(r.response.text) === "VIEWS",
    );
    expect(navRow).toBeDefined();
    if (!navRow) return;
    const ref = navRow.response.text;
    const refView = extractPlannerView(ref);
    const wrongView = refView === "wallet" ? "calendar" : "wallet";
    const wrongViewOut = JSON.stringify({
      action: "VIEWS",
      parameters: { action: "show", view: wrongView },
    });
    const wrongActionOut = JSON.stringify({ action: "REPLY", parameters: {} });
    expect(scorePlannerAction(wrongViewOut, ref)).toBe(0.5);
    expect(scorePlannerAction(wrongActionOut, ref)).toBe(0);
  });
});
