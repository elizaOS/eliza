/** Verifies the Discord Gateway ownership controls and persisted payload. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordGatewayConnection } from "./discord-gateway-connection";

const apiMocks = vi.hoisted(() => ({
  api: vi.fn(),
  apiFetch: vi.fn(),
  connections: [] as Array<Record<string, unknown>>,
  translate: (
    key: string,
    options?: { defaultValue?: string; [name: string]: unknown },
  ) => {
    let value = options?.defaultValue ?? key;
    for (const [name, replacement] of Object.entries(options ?? {})) {
      value = value.replace(`{{${name}}}`, String(replacement));
    }
    return value;
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
    }
  },
  api: apiMocks.api,
  apiFetch: apiMocks.apiFetch,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => apiMocks.translate,
}));

vi.mock("../../cloud-ui/components/connection-card", () => ({
  ConnectionCard: ({
    setupContent,
    connectedContent,
    status,
  }: {
    setupContent?: React.ReactNode;
    connectedContent?: React.ReactNode;
    status?: string;
  }) => <div>{status === "connected" ? connectedContent : setupContent}</div>,
  ConnectionCallout: () => null,
  ConnectionDisconnectAction: () => null,
  ConnectionInstructions: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

beforeEach(() => {
  apiMocks.connections = [];
  apiMocks.api.mockImplementation(
    async (path: string, init?: { method?: string; json?: unknown }) => {
      if (path === "/api/v1/discord/connections" && init?.method === "POST") {
        return { success: true };
      }
      if (path === "/api/v1/discord/connections") {
        return { connections: apiMocks.connections };
      }
      if (
        path === "/api/v1/discord/connections/connection-1" &&
        init?.method === "PATCH"
      ) {
        return { success: true };
      }
      if (path === "/api/v1/dashboard") {
        return {
          agents: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Revenue Agent",
            },
          ],
        };
      }
      if (path === "/api/agents") {
        return { agents: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DiscordGatewayConnection ownership controls", () => {
  it("renders the owner and DM policy fields", async () => {
    render(<DiscordGatewayConnection />);

    expect(await screen.findByLabelText("Discord Owner ID")).toBeTruthy();
    expect(screen.getByLabelText("DM policy")).toBeTruthy();
    expect(screen.getByLabelText("DM allowlist")).toBeTruthy();
  });

  it("persists normalized ownership metadata when creating a connection", async () => {
    render(<DiscordGatewayConnection />);

    fireEvent.change(await screen.findByLabelText("Application ID"), {
      target: { value: "123456789012345678" },
    });
    fireEvent.change(screen.getByLabelText("Bot Token"), {
      target: { value: "not-a-real-token" },
    });
    fireEvent.change(screen.getByLabelText("Discord Owner ID"), {
      target: { value: "234567890123456789" },
    });
    fireEvent.change(screen.getByLabelText("DM allowlist"), {
      target: { value: "456789012345678901" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Discord Bot" }),
    );

    await waitFor(() =>
      expect(apiMocks.api).toHaveBeenCalledWith(
        "/api/v1/discord/connections",
        expect.objectContaining({
          method: "POST",
          json: {
            applicationId: "123456789012345678",
            botToken: "not-a-real-token",
            characterId: "11111111-1111-4111-8111-111111111111",
            metadata: {
              responseMode: "always",
              ownerDiscordUserId: "234567890123456789",
              dmPolicy: "pairing",
              allowFrom: ["456789012345678901"],
            },
          },
        }),
      ),
    );
  });

  it("loads and updates ownership metadata for an existing connection", async () => {
    apiMocks.connections = [
      {
        id: "connection-1",
        applicationId: "123456789012345678",
        botUserId: "123456789012345679",
        characterId: "11111111-1111-4111-8111-111111111111",
        status: "connected",
        errorMessage: null,
        guildCount: 1,
        eventsReceived: 2,
        eventsRouted: 2,
        isActive: true,
        metadata: {
          responseMode: "mention",
          ownerDiscordUserId: "234567890123456789",
          dmPolicy: "allowlist",
          allowFrom: ["345678901234567890"],
          enabledChannels: ["567890123456789012"],
        },
        connectedAt: null,
        lastHeartbeat: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ];

    render(<DiscordGatewayConnection />);
    fireEvent.click(await screen.findByText("App: 123456789012345678"));

    const ownerInput = await screen.findByLabelText("Discord Owner ID");
    expect((ownerInput as HTMLInputElement).value).toBe("234567890123456789");
    expect(screen.getByLabelText("DM policy").textContent).toContain(
      "Allowlist",
    );
    expect(
      (screen.getByLabelText("DM allowlist") as HTMLInputElement).value,
    ).toBe("345678901234567890");

    fireEvent.change(ownerInput, {
      target: { value: "456789012345678901" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(apiMocks.api).toHaveBeenCalledWith(
        "/api/v1/discord/connections/connection-1",
        expect.objectContaining({
          method: "PATCH",
          json: {
            characterId: "11111111-1111-4111-8111-111111111111",
            isActive: true,
            metadata: {
              responseMode: "mention",
              ownerDiscordUserId: "456789012345678901",
              dmPolicy: "allowlist",
              allowFrom: ["345678901234567890"],
              enabledChannels: ["567890123456789012"],
            },
          },
        }),
      ),
    );
  });
});
