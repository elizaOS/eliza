/**
 * Renders the redacted context-inspector states with deterministic client and
 * app-state doubles. Assertions prove raw source-like fields never enter the
 * component contract and unavailable responses remain visibly distinct.
 *
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContextInspector: vi.fn(),
  activeConversationId: "00000000-0000-4000-8000-000000000101" as string | null,
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    client: { getContextInspector: mocks.getContextInspector },
  };
});

vi.mock("../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state")>();
  return {
    ...actual,
    useAppSelector: (
      selector: (state: { activeConversationId: string | null }) => unknown,
    ) => selector({ activeConversationId: mocks.activeConversationId }),
  };
});

vi.mock("./views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

import ContextInspectorView from "./ContextInspectorView";

const RESPONSE = {
  schemaVersion: "elizaos.context-inspector/v1" as const,
  entries: [
    {
      reference: "ctx_0123456789abcdef0123",
      kind: "attachment" as const,
      range: { unit: "byte" as const, start: 1024, end: 2048, total: 8192 },
      completeness: "partial-recoverable" as const,
      omissionReason: "token-budget",
      retentionState: "policy-managed" as const,
    },
  ],
  tokenBudgets: [
    {
      usedTokens: 400,
      limitTokens: 1000,
      reservedTokens: 100,
      state: "within-budget" as const,
    },
  ],
  page: {
    offset: 0,
    limit: 20,
    hasPrevious: false,
    hasMore: false,
    nextOffset: null,
  },
  state: "available" as const,
};

describe("ContextInspectorView", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.activeConversationId = "00000000-0000-4000-8000-000000000101";
    mocks.getContextInspector.mockReset();
    mocks.getContextInspector.mockResolvedValue(RESPONSE);
  });

  it("renders only the redacted range, completeness, retention, and budget DTO", async () => {
    render(<ContextInspectorView />);

    expect(await screen.findByText("ctx_0123456789abcdef0123")).toBeTruthy();
    expect(screen.getByText("byte 1024–2048 of 8192")).toBeTruthy();
    expect(screen.getByText("partial-recoverable")).toBeTruthy();
    expect(screen.getByText("policy-managed")).toBeTruthy();
    expect(screen.getByText("token-budget")).toBeTruthy();
    expect(
      screen.getByTestId("context-inspector-budget").textContent,
    ).toContain("400");
    expect(document.body.textContent).not.toContain("/Users/");
    expect(document.body.textContent).not.toContain("providerAccountId");
    expect(mocks.getContextInspector).toHaveBeenCalledWith(
      mocks.activeConversationId,
      { offset: 0, limit: 20 },
    );
  });

  it("shows explicit no-conversation and transport-error states", async () => {
    mocks.activeConversationId = null;
    const first = render(<ContextInspectorView />);
    expect(screen.getByText("No active conversation")).toBeTruthy();
    expect(mocks.getContextInspector).not.toHaveBeenCalled();
    first.unmount();

    mocks.activeConversationId = "00000000-0000-4000-8000-000000000101";
    mocks.getContextInspector.mockRejectedValueOnce(
      new Error("Context inspector access denied"),
    );
    render(<ContextInspectorView />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Context state unavailable",
    );
    expect(screen.getByText("Context inspector access denied")).toBeTruthy();
  });

  it("refreshes through the same scoped API contract", async () => {
    render(<ContextInspectorView />);
    await screen.findByText("ctx_0123456789abcdef0123");
    fireEvent.click(screen.getByTestId("context-inspector-refresh"));
    await waitFor(() =>
      expect(mocks.getContextInspector).toHaveBeenCalledTimes(2),
    );
  });
});
