/**
 * Deterministic adapter coverage for exact official Gmail and Calendar MCP
 * calls. The MCP transport is fake; account policy, discovery curation, and
 * facade-to-tool argument mapping use the production implementation.
 */
import {
  type Action,
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import type { McpResourceEngine } from "@elizaos/plugin-mcp/resource-engine";
import { describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceService } from "./service.js";

const ACCOUNT: ConnectorAccount = {
  id: "google-personal-1",
  provider: "google",
  role: "OWNER",
  purpose: ["reading", "writing"],
  accessGate: "open",
  status: "connected",
  capabilities: [
    "gmail.draft",
    "gmail.manage",
    "calendar.read",
    "drive.read",
    "docs.read",
    "docs.write",
  ],
  scopes: [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents",
  ],
  selectedProducts: ["gmail", "calendar", "drive", "docs"],
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

function runtimeHarness(): IAgentRuntime & { actions: Action[] } {
  const actions: Action[] = [];
  return {
    agentId: "10000000-0000-0000-0000-000000000001" as UUID,
    actions,
    getService: () => undefined,
    registerAction(action: Action) {
      actions.push(action);
    },
    unregisterAction(name: string) {
      const index = actions.findIndex((action) => action.name === name);
      if (index < 0) return false;
      actions.splice(index, 1);
      return true;
    },
  } as IAgentRuntime & { actions: Action[] };
}

function engineHarness() {
  const callTool = vi.fn(async (_ref, call: { name: string }) => {
    if (call.name === "create_draft") {
      return { content: [], structuredContent: { id: "draft-1", threadId: "thread-1" } };
    }
    if (call.name === "list_events") {
      return {
        content: [],
        structuredContent: {
          events: [
            {
              id: "busy",
              start: { dateTime: "2026-08-12T09:00:00Z" },
              end: { dateTime: "2026-08-12T10:00:00Z" },
            },
            {
              id: "free",
              availability: "AVAILABILITY_FREE",
              start: { dateTime: "2026-08-12T10:00:00Z" },
              end: { dateTime: "2026-08-12T11:00:00Z" },
            },
          ],
        },
      };
    }
    if (call.name === "get_file_metadata") {
      return {
        content: [],
        structuredContent: {
          id: "file-1",
          name: "Report",
          fileSize: "42",
          parentId: "folder-1",
          viewUrl: "https://drive.google.com/file-1",
        },
      };
    }
    if (call.name === "read_doc") {
      return { content: [], structuredContent: { content: "Reviewed document text" } };
    }
    throw new Error(`unexpected MCP tool ${call.name}`);
  });
  const engine: McpResourceEngine = {
    attach: vi.fn(async (resource) => ({ key: resource.key, generation: "generation-1" })),
    detach: vi.fn(async () => true),
    discover: vi.fn(async (ref) => ({
      server: { capabilities: { tools: {} } },
      tools: ref.key.endsWith(":gmail")
        ? [{ name: "create_draft", inputSchema: { type: "object" } }]
        : ref.key.endsWith(":calendar")
          ? [{ name: "list_events", inputSchema: { type: "object" } }]
          : ref.key.endsWith(":drive")
            ? [{ name: "get_file_metadata", inputSchema: { type: "object" } }]
            : [{ name: "read_doc", inputSchema: { type: "object" } }],
      resources: [],
      resourceTemplates: [],
    })),
    callTool,
  };
  return { engine, callTool };
}

async function connectedService() {
  const runtime = runtimeHarness();
  await getConnectorAccountManager(runtime).upsertAccount("google", ACCOUNT);
  const { engine, callTool } = engineHarness();
  const service = new GoogleWorkspaceService(runtime, {
    mcpEngine: engine,
    credentialResolver: {
      getAuthClient: async () =>
        ({
          credentials: { access_token: "short-lived" },
          getAccessToken: async () => ({ token: "short-lived" }),
          setCredentials: () => undefined,
        }) as never,
    },
  });
  await service.connectMcpAccount(ACCOUNT);
  return { service, callTool };
}

describe("GoogleWorkspaceService MCP adapters", () => {
  it("creates a Gmail draft and never turns it into a delivery receipt", async () => {
    const { service, callTool } = await connectedService();

    await expect(
      service.createGmailDraft({
        accountId: ACCOUNT.id,
        to: [{ email: "person@example.com" }],
        subject: "Review",
        text: "Please review this.",
        replyToMessageId: "message-1",
      })
    ).resolves.toEqual({ draftId: "draft-1", threadId: "thread-1" });
    expect(callTool).toHaveBeenCalledWith(expect.any(Object), {
      name: "create_draft",
      arguments: {
        to: ["person@example.com"],
        subject: "Review",
        body: "Please review this.",
        replyToMessageId: "message-1",
      },
    });
    expect(callTool.mock.calls.some(([, call]) => call.name === "send_email")).toBe(false);
  });

  it("rejects Calendar writes before opening an MCP tool call", async () => {
    const { service, callTool } = await connectedService();

    await expect(
      service.updateEvent({
        accountId: ACCOUNT.id,
        eventId: "event-1",
        title: "Updated planning",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_MCP_SAFE_CALENDAR_WRITE_UNSUPPORTED" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("maps the official Drive and Docs MCP response fields", async () => {
    const { service } = await connectedService();

    await expect(service.getFile({ accountId: ACCOUNT.id, fileId: "file-1" })).resolves.toEqual(
      expect.objectContaining({
        id: "file-1",
        size: "42",
        parents: ["folder-1"],
        webViewLink: "https://drive.google.com/file-1",
      })
    );
    await expect(
      service.getDocContent({ accountId: ACCOUNT.id, documentId: "doc-1" })
    ).resolves.toEqual({ title: "Google Doc", plainText: "Reviewed document text" });
  });

  it("fails closed for personal-Google operations absent from official MCP", async () => {
    const { service, callTool } = await connectedService();

    await expect(
      service.appendToDoc({ accountId: ACCOUNT.id, documentId: "doc-1", text: "more" })
    ).rejects.toMatchObject({ code: "GOOGLE_MCP_OPERATION_UNSUPPORTED" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("excludes transparent events from derived busy windows", async () => {
    const { service } = await connectedService();

    await expect(
      service.queryFreeBusy({
        accountId: ACCOUNT.id,
        calendarIds: ["primary"],
        timeMin: "2026-08-12T08:00:00Z",
        timeMax: "2026-08-12T12:00:00Z",
      })
    ).resolves.toMatchObject({
      calendars: {
        primary: { busy: [{ start: "2026-08-12T09:00:00Z", end: "2026-08-12T10:00:00Z" }] },
      },
    });
  });
});
