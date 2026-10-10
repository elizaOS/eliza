// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../../api/client";

vi.mock("../../../agent-surface/useAgentElement", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => {},
}));

vi.mock("../../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

import { DatabaseView } from "../DatabaseView";

describe("DatabaseView agent authority switching", () => {
  const originalBaseUrl = client.getBaseUrl();
  const originalGetDatabaseStatus = client.getDatabaseStatus;
  const originalGetDatabaseTables = client.getDatabaseTables;
  let releaseAgentBTables: (() => void) | undefined;

  beforeEach(() => {
    client.setBaseUrl("http://agent-a.invalid");
    client.getDatabaseStatus = vi.fn(async () => ({
      provider: "pglite",
      connected: true,
      serverVersion: "test",
      tableCount: 1,
      pgliteDataDir: null,
      postgresHost: null,
    }));
    client.getDatabaseTables = vi.fn(async () => {
      const isAgentA = client.getBaseUrl().includes("agent-a");
      if (!isAgentA) {
        await new Promise<void>((resolve) => {
          releaseAgentBTables = resolve;
        });
      }
      return {
        tables: [
          {
            name: isAgentA ? "agent_a_private" : "agent_b_private",
            schema: "public",
            rowCount: 1,
            columns: [],
          },
        ],
      };
    });
  });

  afterEach(() => {
    cleanup();
    client.getDatabaseStatus = originalGetDatabaseStatus;
    client.getDatabaseTables = originalGetDatabaseTables;
    client.setBaseUrl(originalBaseUrl || null);
  });

  it("removes the departed agent table before the new agent table loads", async () => {
    render(<DatabaseView />);
    expect(await screen.findByText("agent_a_private")).toBeTruthy();

    act(() => {
      client.setBaseUrl("http://agent-b.invalid");
    });

    await waitFor(() =>
      expect(client.getDatabaseTables).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByText("agent_a_private")).toBeNull(),
    );
    await act(async () => {
      releaseAgentBTables?.();
    });
    expect(await screen.findByText("agent_b_private")).toBeTruthy();
  });
});
