/**
 * Verifies the agent Google connector surface against deterministic Cloud API
 * doubles: existing-account binding, atomic OAuth binding, and per-agent revoke.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, connectMock } = vi.hoisted(() => ({
  apiMock:
    vi.fn<
      (
        path: string,
        init?: { method?: string; json?: unknown; signal?: AbortSignal },
      ) => Promise<unknown>
    >(),
  connectMock: vi.fn<
    (input: {
      scopes: string[];
      agentBinding: unknown;
      redirectUrl: string;
    }) => Promise<void>
  >(async () => {}),
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class extends Error {
    body?: unknown;
  },
  api: (
    path: string,
    init?: { method?: string; json?: unknown; signal?: AbortSignal },
  ) => apiMock(path, init),
}));

vi.mock("../../connectors/oauth-connection", () => ({
  useOAuthConnections: () => ({
    activeConnections: [
      {
        id: "00000000-0000-4000-8000-000000000020",
        platform: "google",
        platformUserId: "google-user-1",
        email: "owner@example.com",
        status: "active",
        scopes: [],
      },
    ],
    isLoading: false,
    isConnecting: false,
    disconnectingId: null,
    connect: connectMock,
    disconnect: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

import { ElizaAgentConnectorsSection } from "./eliza-agent-connectors-section";

const AGENT_ID = "00000000-0000-4000-8000-000000000010";

beforeEach(() => {
  apiMock.mockReset();
  connectMock.mockClear();
});

afterEach(cleanup);

describe("ElizaAgentConnectorsSection", () => {
  it("binds an already connected account without starting OAuth", async () => {
    apiMock.mockImplementation(
      async (_path: string, init?: { method?: string }) => {
        if (init?.method === "POST") return { id: "binding-1" };
        return [];
      },
    );

    render(<ElizaAgentConnectorsSection agentId={AGENT_ID} />);
    await screen.findByText("owner@example.com");
    expect(screen.getByText("Grant or rebind required")).toBeTruthy();
    expect(
      screen.getByText(
        "Existing Google connection found. Grant or rebind it to this agent without signing in to Google again.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Grant or rebind selected access",
      }),
    );

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/eliza/agents/${AGENT_ID}/connectors`,
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({
            platformCredentialId: "00000000-0000-4000-8000-000000000020",
            provider: "google",
            role: "OWNER",
            selectedProducts: ["gmail", "calendar"],
          }),
        }),
      ),
    );
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("starts OAuth with an atomic agent binding and draft-only scopes", async () => {
    apiMock.mockResolvedValue([]);
    render(<ElizaAgentConnectorsSection agentId={AGENT_ID} />);
    await screen.findByText("owner@example.com");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Connect another Google account and grant access",
      }),
    );

    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUrl: `/dashboard/agents/${AGENT_ID}?tab=connectors`,
        agentBinding: {
          agentId: AGENT_ID,
          role: "OWNER",
          selectedProducts: ["gmail", "calendar"],
          isDefault: true,
        },
      }),
    );
    const input = connectMock.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    if (!input) throw new Error("OAuth input was not recorded");
    expect(input.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
    expect(input.scopes).not.toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("revokes only the selected agent binding", async () => {
    const binding = {
      id: "00000000-0000-4000-8000-000000000030",
      agentId: AGENT_ID,
      provider: "google",
      status: "connected",
      selectedProducts: ["gmail"],
      allowedCapabilities: ["gmail.read", "gmail.draft"],
      isDefault: true,
      externalIdentity: {
        id: "google-user-1",
        displayHandle: "owner@example.com",
      },
    };
    let listed = false;
    apiMock.mockImplementation(
      async (_path: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") return undefined;
        if (!listed) {
          listed = true;
          return [binding];
        }
        return [];
      },
    );

    render(<ElizaAgentConnectorsSection agentId={AGENT_ID} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove agent access" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/eliza/agents/${AGENT_ID}/connectors/${binding.id}`,
        { method: "DELETE" },
      ),
    );
  });
});
