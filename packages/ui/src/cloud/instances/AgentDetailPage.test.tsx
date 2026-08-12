/** Verifies agent detail rendering rejects malformed API timestamps. */
// @vitest-environment jsdom

import type { AgentDetailDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT:
    () => (_key: string, options?: { defaultValue?: string; n?: number }) =>
      (options?.defaultValue ?? _key).replace("{{n}}", String(options?.n)),
}));

vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "a@b.test" },
  }),
}));

vi.mock("../lib/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));

const agentState: {
  data: AgentDetailDto;
  isLoading: boolean;
  error: Error | null;
} = {
  data: {} as AgentDetailDto,
  isLoading: false,
  error: null,
};

vi.mock("./lib/data/eliza-agents", () => ({
  useAgent: () => agentState,
}));

vi.mock("./components/agent-actions", () => ({
  ElizaAgentActions: () => null,
}));
vi.mock("./components/docker-logs-viewer", () => ({
  DockerLogsViewer: () => null,
}));
vi.mock("./components/eliza-agent-backups-panel", () => ({
  ElizaAgentBackupsPanel: () => null,
}));
vi.mock("./components/eliza-agent-logs-viewer", () => ({
  ElizaAgentLogsViewer: () => null,
}));
vi.mock("./components/eliza-agent-tabs", () => ({
  ElizaAgentTabs: () => null,
}));
vi.mock("./components/eliza-connect-button", () => ({
  ElizaConnectButton: () => null,
}));

import { PageHeaderProvider } from "../../cloud-ui/components/layout";
import AgentDetailPage, {
  formatDate,
  formatRelativeShort,
} from "./AgentDetailPage";

const t = vi.fn(
  (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
) as never;

const baseAgent: AgentDetailDto = {
  id: "test-agent-1",
  agentName: "Timestamp Test Agent",
  status: "running",
  databaseStatus: "ready",
  lastBackupAt: null,
  lastHeartbeatAt: "2026-08-12T11:30:00.000Z",
  errorMessage: null,
  createdAt: "2026-08-11T09:15:00.000Z",
  updatedAt: "2026-08-12T11:30:00.000Z",
  token_address: null,
  token_chain: null,
  token_name: null,
  token_ticker: null,
  dockerImage: null,
  executionTier: "shared",
  webUiUrl: null,
  bridgeUrl: null,
  errorCount: 0,
  walletAddress: null,
  walletProvider: null,
  walletStatus: "none",
  adminDetails: null,
};

function renderPage(agent: AgentDetailDto) {
  agentState.data = agent;
  return render(
    <MemoryRouter initialEntries={["/dashboard/agents/test-agent-1"]}>
      <PageHeaderProvider>
        <Routes>
          <Route path="/dashboard/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </PageHeaderProvider>
    </MemoryRouter>,
  );
}

describe("AgentDetailPage date formatting", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders an unavailable fallback for malformed non-null dates", async () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatRelativeShort("not-a-date", t)).toBe("Never");
  });

  it("preserves valid and null date behavior", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatRelativeShort(null, t)).toBe("Never");
    expect(formatRelativeShort(new Date().toISOString(), t)).toBe("Just now");
  });

  it("renders intentional fallbacks for malformed non-null timestamps", () => {
    const { container } = renderPage({
      ...baseAgent,
      createdAt: "not-a-date",
      lastHeartbeatAt: "not-a-date",
    });

    expect(container.textContent).not.toContain("Invalid Date");
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("renders intentional fallbacks outside the ECMAScript TimeClip range", () => {
    const outsideTimeClipRange = "+275760-09-13T00:00:00.001Z";
    expect(Number.isNaN(new Date(outsideTimeClipRange).getTime())).toBe(true);

    const { container } = renderPage({
      ...baseAgent,
      createdAt: outsideTimeClipRange,
      lastHeartbeatAt: outsideTimeClipRange,
    });

    expect(container.textContent).not.toContain("Invalid Date");
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("preserves ordinary rendered date, time, and relative-time values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    const createdAt = "2026-08-11T09:15:00.000Z";
    const lastHeartbeatAt = "2026-08-12T11:30:00.000Z";

    renderPage({ ...baseAgent, createdAt, lastHeartbeatAt });

    expect(screen.getByText(formatDate(createdAt))).toBeTruthy();
    expect(
      screen.getByText(
        new Date(createdAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText("30m ago")).toBeTruthy();
    expect(screen.getByText(formatDate(lastHeartbeatAt))).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText("Never")).toBeNull();
  });
});
