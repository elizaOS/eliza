/** Verifies the responsive Trajectories header and clearance ownership. */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import { TrajectoriesView } from "./TrajectoriesView";

const mediaQueryState = vi.hoisted(() => ({ mobile: true }));
const authorityMock = vi.hoisted(() => ({ value: "agent-a" }));
const clientMock = vi.hoisted(() => ({
  getTrajectories: vi.fn(),
  getTrajectoryConfig: vi.fn(),
}));
const cacheMock = vi.hoisted(() => ({
  getCached: vi.fn(() => null),
  setCached: vi.fn(),
}));
const detailRenderMock = vi.hoisted(() => vi.fn());

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ agentProps: {}, ref: null }),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../../hooks/resource-cache", () => ({
  getCached: cacheMock.getCached,
  setCached: cacheMock.setCached,
}));

vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityMock.value,
}));

vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaQueryState.mobile,
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      setActionNotice: vi.fn(),
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
}));

vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => undefined,
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./TrajectoryDetailView", () => ({
  TrajectoryDetailView: ({ trajectoryId }: { trajectoryId: string }) => {
    detailRenderMock({
      authority: authorityMock.value,
      trajectoryId,
    });
    return <div data-testid="trajectory-detail">{trajectoryId}</div>;
  },
}));

const trajectory = {
  id: "run-1",
  createdAt: "2026-08-25T12:00:00.000Z",
  source: "chat",
  status: "completed",
  scenarioId: null,
  batchId: null,
  llmCallCount: 1,
  providerAccessCount: 0,
  totalPromptTokens: 10,
  totalCompletionTokens: 5,
  durationMs: 1200,
};

describe("TrajectoriesView header lifecycle", () => {
  beforeEach(() => {
    mediaQueryState.mobile = true;
    authorityMock.value = "agent-a";
    detailRenderMock.mockReset();
    clientMock.getTrajectories.mockResolvedValue({
      trajectories: [trajectory],
      total: 1,
      offset: 0,
      limit: 50,
    });
    clientMock.getTrajectoryConfig.mockRejectedValue({ status: 404 });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("replaces the mobile list header with one detail header and keeps clearance at the router boundary", async () => {
    const onSelectTrajectory = vi.fn();
    const rendered = render(
      <TrajectoriesView
        selectedTrajectoryId={null}
        onSelectTrajectory={onSelectTrajectory}
      />,
    );

    expect(screen.getByRole("heading", { name: "Trajectories" })).toBeTruthy();
    await waitFor(() => screen.getByText("1 recorded run"));

    rendered.rerender(
      <TrajectoriesView
        selectedTrajectoryId="run-1"
        onSelectTrajectory={onSelectTrajectory}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Run details" }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("view-header")).toHaveLength(1);
    expect(screen.getByTestId("trajectory-detail").textContent).toBe("run-1");

    fireEvent.click(screen.getByRole("button", { name: "Back to activity" }));
    expect(onSelectTrajectory).toHaveBeenLastCalledWith(null);

    for (const scroller of rendered.container.querySelectorAll<HTMLElement>(
      ".overflow-y-auto",
    )) {
      expect(scroller.className).not.toContain("--eliza-chat-clearance");
      expect(scroller.className).not.toContain("--eliza-mobile-nav-offset");
      expect(scroller.className).not.toContain("--safe-area-bottom");
    }
  });

  it("surfaces the Shared capability boundary once without offering a futile retry", async () => {
    const unavailable = {
      status: 503,
      code: "trajectories_runtime_unavailable",
      data: { retryable: false },
    };
    clientMock.getTrajectories.mockRejectedValue(unavailable);
    clientMock.getTrajectoryConfig.mockRejectedValue(unavailable);

    render(<TrajectoriesView />);

    expect(
      await screen.findByText("Trajectories need a Dedicated agent"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Switch this agent to Dedicated to record and manage trajectory history.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(clientMock.getTrajectories).toHaveBeenCalledTimes(1);
    expect(clientMock.getTrajectoryConfig).toHaveBeenCalledTimes(1);
  });

  it("cancels an agent-A warm-up retry before the client repoints to agent B", async () => {
    vi.useFakeTimers();
    const requestedAuthorities: string[] = [];
    const agentBResult = {
      trajectories: [{ ...trajectory, id: "run-b" }],
      total: 1,
      offset: 0,
      limit: 50,
    };
    clientMock.getTrajectories.mockImplementation(() => {
      requestedAuthorities.push(authorityMock.value);
      if (authorityMock.value === "agent-a") {
        return Promise.reject(
          new ApiError({
            kind: "http",
            path: "/api/trajectories",
            message: "Not found",
            status: 404,
          }),
        );
      }
      return Promise.resolve(agentBResult);
    });

    const rendered = render(<TrajectoriesView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestedAuthorities).toEqual(["agent-a"]);

    authorityMock.value = "agent-b";
    rendered.rerender(<TrajectoriesView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(requestedAuthorities).toEqual(["agent-a", "agent-b"]);
    expect(cacheMock.setCached).toHaveBeenCalledTimes(1);
    expect(cacheMock.setCached).toHaveBeenCalledWith(
      "trajectories:agent-b:0:",
      agentBResult,
    );
  });

  it("does not carry agent-A list or detail state into a deferred agent-B load", async () => {
    mediaQueryState.mobile = false;
    clientMock.getTrajectories.mockImplementation(() =>
      authorityMock.value === "agent-a"
        ? Promise.resolve({
            trajectories: [trajectory],
            total: 1,
            offset: 0,
            limit: 50,
          })
        : new Promise(() => undefined),
    );

    const rendered = render(<TrajectoriesView />);
    await waitFor(() =>
      expect(detailRenderMock).toHaveBeenCalledWith({
        authority: "agent-a",
        trajectoryId: "run-1",
      }),
    );
    detailRenderMock.mockClear();

    authorityMock.value = "agent-b";
    rendered.rerender(<TrajectoriesView />);
    await act(async () => undefined);

    expect(detailRenderMock).not.toHaveBeenCalledWith({
      authority: "agent-b",
      trajectoryId: "run-1",
    });
    expect(screen.queryByTestId("trajectory-detail")).toBeNull();
  });
});
