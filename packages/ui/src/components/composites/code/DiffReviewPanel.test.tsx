// @vitest-environment jsdom
/**
 * Renders DiffReviewPanel in jsdom over ChangeSetData fixtures to cover empty
 * states, per-file collapsible sections, added/removed line classification, and
 * the truncation warning.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSetData } from "../../../api/client-types-cloud";
import { DiffReviewPanel } from "./DiffReviewPanel";

afterEach(cleanup);

function changeSet(overrides: Partial<ChangeSetData> = {}): ChangeSetData {
  return {
    changedFiles: ["src/app.ts", "README.md"],
    diffStat: "2 files changed, 3 insertions(+), 1 deletion(-)",
    diff: [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " const keep = true;",
      "-const old = 1;",
      "+const next = 2;",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -0,0 +1 @@",
      "+Hello world",
    ].join("\n"),
    truncated: false,
    capturedAt: Date.now(),
    ...overrides,
  };
}

describe("DiffReviewPanel", () => {
  it("renders an empty state when no change set is provided", () => {
    render(<DiffReviewPanel changeSet={undefined} />);
    expect(
      screen.getByText("No file changes captured for this task."),
    ).toBeTruthy();
  });

  it("renders an empty state when the change set has no files", () => {
    render(
      <DiffReviewPanel changeSet={changeSet({ changedFiles: [], diff: "" })} />,
    );
    expect(
      screen.getByText("No file changes captured for this task."),
    ).toBeTruthy();
  });

  it("displays the diffStat", () => {
    render(<DiffReviewPanel changeSet={changeSet()} />);
    expect(
      screen.getByText("2 files changed, 3 insertions(+), 1 deletion(-)"),
    ).toBeTruthy();
  });

  it("groups one collapsible section per changed file", () => {
    render(<DiffReviewPanel changeSet={changeSet()} />);
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("classifies added and removed lines with the success/danger tokens", () => {
    render(<DiffReviewPanel changeSet={changeSet()} />);
    const added = screen.getByText("+const next = 2;");
    const removed = screen.getByText("-const old = 1;");
    const hunk = screen.getByText("@@ -1,3 +1,3 @@");
    expect(added.className).toContain("text-success");
    expect(removed.className).toContain("text-destructive");
    expect(hunk.className).toContain("text-warning");
  });

  it("shows a section for a changed file even when its diff text is absent", () => {
    render(
      <DiffReviewPanel
        changeSet={changeSet({
          changedFiles: ["src/app.ts", "data/generated.bin"],
          diff: [
            "diff --git a/src/app.ts b/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1 @@",
            "+x",
          ].join("\n"),
        })}
      />,
    );
    expect(screen.getByText("data/generated.bin")).toBeTruthy();
    expect(
      screen.getByText("No inline diff captured for this file."),
    ).toBeTruthy();
  });

  it("renders a truncation warning when truncated is true", () => {
    render(<DiffReviewPanel changeSet={changeSet({ truncated: true })} />);
    expect(screen.getByText(/This diff is truncated/)).toBeTruthy();
  });

  it("does not render a truncation warning when truncated is false", () => {
    render(<DiffReviewPanel changeSet={changeSet({ truncated: false })} />);
    expect(screen.queryByText(/This diff is truncated/)).toBeNull();
  });

  it("collapses a file section when its header is toggled", () => {
    render(<DiffReviewPanel changeSet={changeSet()} />);
    expect(screen.getByText("+const next = 2;")).toBeTruthy();
    const header = screen.getByText("src/app.ts").closest("button");
    if (!header) throw new Error("file header button missing");
    fireEvent.click(header);
    expect(screen.queryByText("+const next = 2;")).toBeNull();
  });
});
