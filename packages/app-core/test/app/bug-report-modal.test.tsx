import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- hoisted mocks ----------------------------------------------------------

const { mockUseBugReport, mockClient } = vi.hoisted(() => ({
  mockUseBugReport: vi.fn(),
  mockClient: {
    getCodingAgentStatus: vi.fn(async () => null),
    checkBugReportInfo: vi.fn().mockResolvedValue({}),
    submitBugReport: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@elizaos/app-core/hooks", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/hooks")
  >("@elizaos/app-core/hooks");
  return {
    ...actual,
    useBugReport: () => mockUseBugReport(),
  };
});

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
}));

import { BugReportModal } from "@elizaos/app-core/components/BugReportModal";

// --- helpers ----------------------------------------------------------------

let closeFn: ReturnType<typeof vi.fn>;

function setupMock(isOpen: boolean) {
  closeFn = vi.fn();
  mockUseBugReport.mockReturnValue({ isOpen, close: closeFn });
}

function getButtons(root: TestRenderer.ReactTestInstance) {
  return root.findAllByType("button" as React.ElementType);
}

function getTextareas(root: TestRenderer.ReactTestInstance) {
  return root.findAllByType("textarea" as React.ElementType);
}

function getText(root: TestRenderer.ReactTestInstance): string {
  return root
    .findAllByType("span" as React.ElementType)
    .map((n) => n.children.join(""))
    .join("\n");
}

function findButton(root: TestRenderer.ReactTestInstance, label: string) {
  return getButtons(root).find((b) => b.children.join("").includes(label));
}

/** Fill both required fields and return the tree root. */
async function fillRequired(root: TestRenderer.ReactTestInstance) {
  const textareas = getTextareas(root);
  await act(async () => {
    textareas[0].props.onChange({ target: { value: "Bug description" } });
  });
  await act(async () => {
    textareas[1].props.onChange({ target: { value: "1. Click button" } });
  });
}

// --- tests ------------------------------------------------------------------

describe("BugReportModal", () => {
  beforeEach(() => {
    mockUseBugReport.mockReset();
    mockClient.checkBugReportInfo.mockReset().mockResolvedValue({});
    mockClient.submitBugReport.mockReset().mockResolvedValue({});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- rendering ---

  it("renders nothing when closed", () => {
    setupMock(false);
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
    });
    expect(tree?.toJSON()).toBeNull();
  });

  it("renders modal with header when open", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });
    expect(getText(tree?.root)).toContain("bugreportmodal.ReportABug");
  });

  it("renders required field markers", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });
    const labels = tree?.root.findAllByType("label" as React.ElementType);
    const requiredLabels = labels?.filter((l) =>
      l
        .findAllByType("span" as React.ElementType)
        .flatMap((s) => s.children)
        .some((c) => typeof c === "string" && c.includes("*")),
    );
    expect(requiredLabels?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders all form textareas and inputs", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });
    // Description, Steps to Reproduce, Expected Behavior, Actual Behavior
    expect(getTextareas(tree?.root).length).toBeGreaterThanOrEqual(4);
    // Node Version, Model Provider
    const inputs = tree?.root.findAllByType("input" as React.ElementType);
    expect(inputs?.length).toBeGreaterThanOrEqual(2);
  });

  // --- env info fetch ---

  it("fetches env info on open", async () => {
    mockClient.checkBugReportInfo.mockResolvedValue({
      nodeVersion: "v22.0.0",
      platform: "darwin",
    });
    setupMock(true);
    await act(async () => {
      TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });
    expect(mockClient.checkBugReportInfo).toHaveBeenCalledOnce();
  });

  // --- validation ---

  it("disables submit when required fields are empty", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });
    const submitBtn = findButton(tree?.root, "Submit");
    expect(submitBtn?.props.disabled).toBe(true);
  });

  it("shows validation error on empty submit attempt", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    const submitBtn = findButton(tree?.root, "Submit");
    await act(async () => {
      submitBtn?.props.onClick();
    });

    const errorDivs = tree?.root.findAll(
      (node) => node.type === "div" && node.props.style?.color === "#ef4444",
    );
    expect(errorDivs?.length).toBeGreaterThan(0);
  });

  // --- submission ---

  it("calls submitBugReport on valid submit", async () => {
    mockClient.submitBugReport.mockResolvedValue({
      url: "https://github.com/elizaos/eliza/issues/99",
    });
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    await fillRequired(tree?.root);

    const submitBtn = findButton(tree?.root, "Submit");
    await act(async () => {
      submitBtn?.props.onClick();
    });

    expect(mockClient.submitBugReport).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Bug description",
        stepsToReproduce: "1. Click button",
      }),
    );
  });

  it("does not send screenshot field to server", async () => {
    mockClient.submitBugReport.mockResolvedValue({
      url: "https://example.com",
    });
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    await fillRequired(tree?.root);

    const submitBtn = findButton(tree?.root, "Submit");
    await act(async () => {
      submitBtn?.props.onClick();
    });

    const callArg = mockClient.submitBugReport.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("screenshot");
  });

  it("shows success state with issue URL after submit", async () => {
    const issueUrl = "https://github.com/elizaos/eliza/issues/99";
    mockClient.submitBugReport.mockResolvedValue({ url: issueUrl });
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    await fillRequired(tree?.root);

    const submitBtn = findButton(tree?.root, "Submit");
    await act(async () => {
      submitBtn?.props.onClick();
    });

    expect(getText(tree?.root)).toContain("bugreportmodal.BugReportSubmitted");
    const link = tree?.root.findByType("a" as React.ElementType);
    expect(link?.props.href).toBe(issueUrl);
  });

  it("shows error message on submit failure", async () => {
    mockClient.submitBugReport.mockRejectedValue(new Error("Network error"));
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    await fillRequired(tree?.root);

    const submitBtn = findButton(tree?.root, "Submit");
    await act(async () => {
      submitBtn?.props.onClick();
    });

    const errorDivs = tree?.root.findAll(
      (node) =>
        node.type === "div" &&
        node.props.style?.color === "#ef4444" &&
        node.children.some(
          (c) => typeof c === "string" && c.includes("Network error"),
        ),
    );
    expect(errorDivs?.length).toBe(1);
  });

  // --- fallback mode ---

  it("does not show success URL on fallback response", async () => {
    mockClient.submitBugReport.mockResolvedValue({
      fallback: "https://github.com/elizaos/eliza/issues/new",
    });
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    await fillRequired(tree?.root);

    const submitBtn = findButton(tree?.root, "Submit");
    await act(async () => {
      submitBtn?.props.onClick();
    });

    // Fallback path does not transition to success URL view
    expect(getText(tree?.root)).not.toContain(
      "bugreportmodal.BugReportSubmitted",
    );
    // Form should still be visible (not replaced by success state)
    expect(getTextareas(tree?.root).length).toBeGreaterThan(0);
  });

  // --- close behavior ---

  it("calls close on Cancel button click", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    const cancelBtn = findButton(tree?.root, "onboarding.cancel");
    act(() => {
      cancelBtn?.props.onClick();
    });

    expect(closeFn).toHaveBeenCalled();
  });

  // --- logs toggle ---

  it("toggles logs textarea visibility", async () => {
    setupMock(true);
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BugReportModal));
      await vi.runAllTimersAsync();
    });

    const before = getTextareas(tree?.root).length;

    const logsToggle = getButtons(tree?.root).find((b) =>
      b.children.some(
        (c) => typeof c === "string" && c.trim() === "bugreportmodal.Logs",
      ),
    );
    act(() => {
      logsToggle?.props.onClick();
    });

    const after = getTextareas(tree?.root).length;
    expect(after).toBe(before + 1);
  });
});
