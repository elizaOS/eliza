/**
 * Verifies Discord connection edits preserve access-control metadata that the
 * Cloud form does not expose, including conflict refresh through the real form.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordConnectionMetadataUpdate,
  buildDiscordConnectionPatch,
} from "./discord-connection-metadata";
import { DiscordGatewayConnection } from "./discord-gateway-connection";

const { apiMock, apiFetchMock, MockApiError, toastErrorMock, translate } =
  vi.hoisted(() => {
    class TestApiError extends Error {
      constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly body?: unknown,
      ) {
        super(message);
        this.name = "ApiError";
      }
    }
    return {
      apiMock: vi.fn(),
      apiFetchMock: vi.fn(),
      MockApiError: TestApiError,
      toastErrorMock: vi.fn(),
      translate: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
    };
  });

vi.mock("../lib/api-client", () => ({
  api: apiMock,
  apiFetch: apiFetchMock,
  ApiError: MockApiError,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => translate,
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastErrorMock,
    success: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("buildDiscordConnectionMetadataUpdate", () => {
  it("preserves keyword, channel, and plural-owner restrictions", () => {
    const stored = {
      responseMode: "keyword" as const,
      keywords: ["help", "support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
      ownerDiscordUserId: "111111111111111",
      ownerDiscordUserIds: ["222222222222222", "333333333333333"],
      dmPolicy: "pairing" as const,
      dmAllowFrom: ["444444444444444"],
    };

    const result = buildDiscordConnectionMetadataUpdate(stored, {
      responseMode: "keyword",
      ownerDiscordUserId: " 555555555555555 ",
      dmPolicy: "allowlist",
      dmAllowFrom: ["666666666666666"],
    });

    expect(result).toEqual({
      responseMode: "keyword",
      keywords: ["help", "support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
      ownerDiscordUserId: "555555555555555",
      ownerDiscordUserIds: ["222222222222222", "333333333333333"],
      dmPolicy: "allowlist",
      dmAllowFrom: ["666666666666666"],
    });
    expect(stored).toEqual({
      responseMode: "keyword",
      keywords: ["help", "support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
      ownerDiscordUserId: "111111111111111",
      ownerDiscordUserIds: ["222222222222222", "333333333333333"],
      dmPolicy: "pairing",
      dmAllowFrom: ["444444444444444"],
    });
  });

  it("clears open and empty DM controls without dropping unrelated metadata", () => {
    expect(
      buildDiscordConnectionMetadataUpdate(
        {
          responseMode: "mention",
          enabledChannels: ["channel-allow"],
          ownerDiscordUserId: "111111111111111",
          dmPolicy: "disabled",
          dmAllowFrom: ["222222222222222"],
        },
        {
          responseMode: "always",
          ownerDiscordUserId: "",
          dmPolicy: "open",
          dmAllowFrom: [],
        },
      ),
    ).toEqual({
      responseMode: "always",
      enabledChannels: ["channel-allow"],
    });
  });

  it("serializes the row version and complete metadata into the PATCH payload", () => {
    expect(
      buildDiscordConnectionPatch(
        {
          responseMode: "keyword",
          keywords: ["support"],
          disabledChannels: ["channel-deny"],
        },
        "4271",
        {
          characterId: null,
          isActive: true,
          responseMode: "keyword",
          ownerDiscordUserId: "111111111111111",
          dmPolicy: "pairing",
          dmAllowFrom: [],
          botToken: "replacement-token",
        },
      ),
    ).toEqual({
      characterId: null,
      isActive: true,
      metadata: {
        responseMode: "keyword",
        keywords: ["support"],
        disabledChannels: ["channel-deny"],
        ownerDiscordUserId: "111111111111111",
        dmPolicy: "pairing",
      },
      expectedEditVersion: "4271",
      botToken: "replacement-token",
    });
  });
});

describe("DiscordGatewayConnection editor concurrency", () => {
  it("loads the exact row on open and preserves the draft across a 409 refresh", async () => {
    const connectionId = "33333333-3333-4333-8333-333333333333";
    const characterId = "44444444-4444-4444-8444-444444444444";
    const baseConnection = {
      id: connectionId,
      applicationId: "discord-app",
      botUserId: null,
      characterId,
      status: "connected" as const,
      errorMessage: null,
      guildCount: 1,
      eventsReceived: 2,
      eventsRouted: 2,
      isActive: true,
      metadata: {
        responseMode: "keyword" as const,
        keywords: ["support"],
        enabledChannels: ["channel-allow"],
        ownerDiscordUserId: "111111111111111",
      },
      connectedAt: null,
      lastHeartbeat: null,
      createdAt: "2026-08-15T09:00:00.000Z",
      editVersion: "1",
    };
    const openedConnection = { ...baseConnection, editVersion: "2" };
    const conflictedConnection = {
      ...baseConnection,
      editVersion: "3",
      metadata: {
        ...baseConnection.metadata,
        disabledChannels: ["concurrent-channel-deny"],
      },
    };
    let detailReads = 0;
    let patchAttempts = 0;

    apiMock.mockImplementation(
      async (path: string, options?: { method?: string; json?: unknown }) => {
        if (path === "/api/v1/discord/connections") {
          return { connections: [baseConnection] };
        }
        if (path === "/api/v1/dashboard") {
          return { agents: [{ id: characterId, name: "Cloud Agent" }] };
        }
        if (path === `/api/v1/discord/connections/${connectionId}`) {
          if (options?.method === "PATCH") {
            patchAttempts += 1;
            if (patchAttempts === 1) {
              throw new MockApiError(409, "CONFLICT", "Connection changed");
            }
            return {
              success: true,
              connection: { ...conflictedConnection, editVersion: "4" },
            };
          }
          detailReads += 1;
          return {
            connection:
              detailReads === 1 ? openedConnection : conflictedConnection,
          };
        }
        throw new Error(`Unexpected API request: ${path}`);
      },
    );

    render(createElement(DiscordGatewayConnection));
    fireEvent.click(await screen.findByText("App: {{appId}}"));

    const ownerInput = await screen.findByDisplayValue("111111111111111");
    expect(detailReads).toBe(1);
    fireEvent.change(ownerInput, { target: { value: "555555555555555" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(detailReads).toBe(2));
    expect(screen.getByDisplayValue("555555555555555")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(patchAttempts).toBe(2));
    const patchCalls = apiMock.mock.calls.filter(
      ([path, options]) =>
        path === `/api/v1/discord/connections/${connectionId}` &&
        options?.method === "PATCH",
    );
    expect(patchCalls[1]?.[1]?.json).toMatchObject({
      expectedEditVersion: "3",
      metadata: {
        keywords: ["support"],
        enabledChannels: ["channel-allow"],
        disabledChannels: ["concurrent-channel-deny"],
        ownerDiscordUserId: "555555555555555",
      },
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull(),
    );
  });
});
