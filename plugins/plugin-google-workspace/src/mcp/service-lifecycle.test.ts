/**
 * Integration-style lifecycle tests for the Google service's MCP host wiring.
 * The runtime registry and MCP transport are deterministic fakes; credential
 * resolution uses the service's real access-token bridge.
 */
import { type ConnectorAccount, getConnectorAccountManager } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { GoogleWorkspaceService } from "../service";
import { engineHarness, runtimeHarness, stubCredentialResolver } from "./__tests__/test-support.js";

function googleAccount(): ConnectorAccount {
  return {
    id: "google-personal",
    provider: "google",
    role: "OWNER",
    purpose: ["reading"],
    accessGate: "open",
    status: "connected",
    capabilities: ["gmail.read"],
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    selectedProducts: ["gmail"],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("GoogleWorkspaceService MCP lifecycle", () => {
  it("hosts local selected products with short-lived access and removes actions on stop", async () => {
    const runtime = runtimeHarness();
    const { engine, detach, attachedResources } = engineHarness({
      toolsFor: () => [
        {
          name: "search_threads",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      callTool: () => ({ content: [] }),
    });
    const service = new GoogleWorkspaceService(runtime, {
      credentialResolver: stubCredentialResolver(),
      mcpEngine: engine,
    });

    await expect(service.connectMcpAccount(googleAccount())).resolves.toMatchObject({
      products: { gmail: { status: "connected" } },
    });
    expect(runtime.actions.map((action) => action.name)).toEqual(["GOOGLE_GMAIL_SEARCH_THREADS"]);
    const attachedResource = attachedResources[0];
    await expect(
      attachedResource?.auth?.getAccessToken({
        key: attachedResource.key,
        endpoint: new URL(String(attachedResource.endpoint)),
        purpose: "call-tool",
      })
    ).resolves.toEqual({ accessToken: "short-lived" });

    await service.stop();

    expect(runtime.actions).toEqual([]);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("uses the curated Calendar MCP read behind the typed service seam", async () => {
    const runtime = runtimeHarness();
    const connectedAccount = {
      ...googleAccount(),
      id: "google-calendar-local",
      capabilities: ["calendar.read"],
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      selectedProducts: ["calendar"],
    };
    await getConnectorAccountManager(runtime).upsertAccount("google", connectedAccount);
    const { engine, callTool } = engineHarness({
      toolsFor: () => [
        {
          name: "list_events",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: { type: "string" },
              startTime: { type: "string" },
              endTime: { type: "string" },
            },
          },
        },
      ],
      callTool: () => ({
        content: [],
        structuredContent: {
          events: [
            {
              id: "event-1",
              summary: "Architecture review",
              start: { dateTime: "2026-08-11T09:00:00+05:30", timeZone: "Asia/Kolkata" },
              end: { dateTime: "2026-08-11T10:00:00+05:30", timeZone: "Asia/Kolkata" },
              htmlLink: "https://calendar.google.com/event?eid=event-1",
            },
          ],
        },
      }),
    });
    const service = new GoogleWorkspaceService(runtime, { mcpEngine: engine });
    await service.connectMcpAccount(connectedAccount);

    await expect(
      service.listEvents({
        accountId: connectedAccount.id,
        calendarId: "primary",
        timeMin: "2026-08-11T00:00:00+05:30",
        timeMax: "2026-08-12T00:00:00+05:30",
        limit: 10,
        timeZone: "Asia/Kolkata",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: "event-1",
        calendarId: "primary",
        title: "Architecture review",
        start: "2026-08-11T09:00:00+05:30",
        end: "2026-08-11T10:00:00+05:30",
      }),
    ]);
    expect(callTool).toHaveBeenCalledWith(expect.any(Object), {
      name: "list_events",
      arguments: {
        calendarId: "primary",
        startTime: "2026-08-11T00:00:00+05:30",
        endTime: "2026-08-12T00:00:00+05:30",
        pageSize: 10,
        timeZone: "Asia/Kolkata",
        orderBy: "startTime",
      },
    });
  });
});
