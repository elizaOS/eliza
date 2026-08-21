/**
 * Renders the trajectory LLM call card with the exact texts the trajectory
 * detail view derives for a sparse recorded call, proving the on-screen line
 * badges match the panels beside them. Deterministic jsdom render of the real
 * card component; no runtime or network is involved.
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrajectoryLlmCallCard } from "../composites/trajectories/trajectory-llm-call-card";
import {
  buildTrajectoryCallText,
  countTrajectoryTextLines,
} from "./TrajectoryDetailView";

type SparseCall = Parameters<typeof buildTrajectoryCallText>[0];

/**
 * Legacy and provider-failure trajectory rows arrive with explicit `null`
 * columns even though the DTO declares the fields optional, so the fixtures
 * are widened deliberately rather than sanitized before the view sees them.
 */
function sparseCall(record: Record<string, unknown>): SparseCall {
  return record as unknown as SparseCall;
}

function renderCall(call: SparseCall) {
  const { systemPromptText, inputText, outputText } =
    buildTrajectoryCallText(call);
  render(
    <TrajectoryLlmCallCard
      callLabel="#1"
      model="gpt-test"
      purposeLabel="Purpose"
      latencyLabel="Latency"
      latencyValue="—"
      tokensLabel="Tokens"
      totalTokensValue="—"
      tokenBreakdownMeta="— ↑ • — ↓"
      temperatureLabel="Temp"
      temperatureValue={0}
      maxLabel="Max"
      maxValue="—"
      systemPrompt={systemPromptText.length > 0 ? systemPromptText : null}
      systemPromptButtonLabel="System prompt"
      systemLabel="System"
      systemLinesLabel={`${countTrajectoryTextLines(systemPromptText)} lines`}
      systemCollapseLabel="Collapse"
      systemExpandLabel="Expand"
      inputLabel="Input"
      outputLabel="Output"
      inputLinesLabel={`${countTrajectoryTextLines(inputText)} lines`}
      outputLinesLabel={`${countTrajectoryTextLines(outputText)} lines`}
      userPrompt={inputText}
      response={outputText}
      copyLabel="Copy"
      copyToClipboardLabel="Copy to clipboard"
      onCopy={() => {}}
    />,
  );
}

describe("sparse trajectory call rendering", () => {
  it("reports zero lines instead of a fabricated single line", () => {
    renderCall(
      sparseCall({
        systemPrompt: undefined,
        userPrompt: undefined,
        prompt: null,
        messages: undefined,
        response: "",
        output: null,
      }),
    );

    expect(screen.getAllByText("0 lines").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("1 lines")).toBeNull();
    expect(screen.queryByText("System prompt")).toBeNull();
  });

  it("renders the populated fallback and counts its real lines", () => {
    renderCall(
      sparseCall({
        systemPrompt: "   ",
        userPrompt: "",
        prompt: "line one\nline two",
        messages: undefined,
        response: null,
        output: "only output line",
      }),
    );

    expect(screen.getByText(/line one/)).toBeTruthy();
    expect(screen.getByText(/only output line/)).toBeTruthy();
    expect(screen.getAllByText("2 lines").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1 lines").length).toBeGreaterThanOrEqual(1);
    // A whitespace-only system prompt stays absent rather than opening an
    // empty panel behind a truthy toggle.
    expect(screen.queryByText("System prompt")).toBeNull();
  });
});
