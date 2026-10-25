import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { AgentGoogleConnectorError } from "../agent-google-connector";
import { buildSharedCapabilityCatalog } from "./shared-capability-catalog";
import { resolveSharedCapabilityWall } from "./shared-capability-wall";
import {
  createSharedGoogleContextPlugin,
  isSharedGoogleContextRequest,
} from "./shared-google-context-plugin";
import { createSharedGoogleReadPort } from "./shared-google-read-port";
import {
  isSharedPublicSearchSafe,
  resolveSharedPublicSearchIntent,
  resolveSharedRealtimeRequirement,
} from "./shared-realtime-grounding";

describe("Google Shared action/capability bridge", () => {
  test("Google reads/connect are enabled while writes and other apps stay blocked", () => {
    for (const text of ["Connect Gmail", "Search Gmail for invoices", "Show my calendar"]) {
      expect(resolveSharedCapabilityWall(text, { googleContext: true })).toBeNull();
    }
    for (const text of ["Send email with Gmail", "Delete my calendar event", "Read Slack"]) {
      expect(resolveSharedCapabilityWall(text, { googleContext: true })).not.toBeNull();
    }
    expect(resolveSharedCapabilityWall("Read Gmail")).not.toBeNull();
    for (const text of ["What's in my inbox?", "Summarize my recent emails", "Connect Gmail"]) {
      expect(isSharedGoogleContextRequest(text)).toBe(true);
    }
    for (const text of [
      "Connect Google",
      "Link Google account",
      "Please connect my Google account.",
    ]) {
      expect(isSharedGoogleContextRequest(text)).toBe(true);
      expect(resolveSharedPublicSearchIntent(text, [])).toBeUndefined();
    }
    for (const text of [
      "What is Gmail?",
      "Google",
      "Tell me about Google",
      "Link Google account API docs",
    ]) {
      expect(isSharedGoogleContextRequest(text)).toBe(false);
    }
    for (const [text, query] of [
      ["Find Gmail API documentation", "Gmail API documentation"],
      ["Read Google Calendar API docs", "Read Google Calendar API docs"],
      ["Find Gmail pricing", "Gmail pricing"],
      ["Help me use Google Calendar", "Help me use Google Calendar"],
    ]) {
      expect(isSharedGoogleContextRequest(text!)).toBe(false);
      expect(isSharedPublicSearchSafe(text!)).toBe(true);
      expect(resolveSharedRealtimeRequirement(text!, [])).toBeUndefined();
      expect(resolveSharedPublicSearchIntent(text!, [])).toEqual({ kind: "general", topic: query });
      expect(resolveSharedCapabilityWall(text!)).toBeNull();
      expect(resolveSharedCapabilityWall(text!, { googleContext: true })).toBeNull();
    }
    for (const text of [
      "Read my Gmail inbox",
      "Show my Google Calendar events",
      "Find Gmail API documentation for my inbox",
    ]) {
      expect(isSharedGoogleContextRequest(text)).toBe(true);
      expect(isSharedPublicSearchSafe(text)).toBe(false);
      expect(resolveSharedRealtimeRequirement(text, [])).toBeUndefined();
    }
    for (const text of [
      "Find Gmail API documentation for alice@example.com",
      "Find Google Calendar help at http://127.0.0.1",
      "Find Gmail API docs \u200b",
    ]) {
      expect(isSharedPublicSearchSafe(text)).toBe(false);
      expect(resolveSharedRealtimeRequirement(text, [])).toBeUndefined();
    }

    for (const text of [
      "Search the web for Gmail API documentation rate limits?",
      'Search the web for "Google Calendar API quota limits"?',
      'Search the web for "Gmail API  C# quota limits"?',
    ]) {
      expect(isSharedGoogleContextRequest(text)).toBe(false);
      expect(resolveSharedPublicSearchIntent(text, [])).toEqual({
        kind: "general",
        topic: text.replace(/^Search the web for /u, "").replace(/\?$/u, ""),
      });
    }
    for (const text of [
      "Search Gmail for API documentation invoices",
      "Search the web for Gmail docs and read my calendar",
      "Find Gmail API documentation and search Gmail for invoices",
    ]) {
      expect(isSharedGoogleContextRequest(text)).toBe(true);
      expect(resolveSharedPublicSearchIntent(text, [])).toBeUndefined();
    }

    // An oversized public documentation topic must stay an explicit public
    // limit error; it must not be reclassified as a private Gmail operation.
    expect(() =>
      resolveSharedPublicSearchIntent(`Search the web for Gmail API docs ${"x".repeat(2048)}`, []),
    ).toThrow("Public search topics must not exceed 2048 characters");

    const catalog = buildSharedCapabilityCatalog({
      webSearch: false,
      reminders: false,
      todos: false,
      media: false,
      googleContext: true,
    });
    expect(catalog.capabilities.find((c) => c.id === "cloud-apps")?.requiredTier).toBe("shared");
    expect(catalog.capabilities.find((c) => c.id === "communications")?.availability).not.toBe(
      "available",
    );
  });

  test("actual plugin action rejects unknown operations without binding owner", async () => {
    let binds = 0;
    const plugin = createSharedGoogleContextPlugin(async () => {
      binds += 1;
      throw new Error("NO_BIND");
    });
    const action = plugin.actions![0]!;
    expect(action.roleGate?.minRole).toBe("USER");
    expect(binds).toBe(0);
    expect(await action.validate({} as IAgentRuntime, {} as Memory)).toBe(true);
    expect(binds).toBe(0);
    const result = await action.handler({} as IAgentRuntime, {} as Memory, undefined, {
      parameters: { operation: "gmail_send" },
    });
    expect(result).toMatchObject({ success: false, data: { code: "INVALID_OPERATION" } });
    expect(binds).toBe(0);
  });

  test("action receipt uses owner-bound read and private source rather than arbitrary scope parameters", async () => {
    let request: unknown;
    const plugin = createSharedGoogleContextPlugin(async () => ({
      connect: async () => {
        throw new Error("NO_CONNECT");
      },
      read: async (value) => {
        request = value;
        return {
          kind: "private_google_gmail_search",
          untrustedContent: true,
          observedAt: "2026-10-08",
          messages: [],
        };
      },
    }));
    const result = await plugin.actions![0]!.handler({} as IAgentRuntime, {} as Memory, undefined, {
      parameters: {
        operation: "gmail_search",
        query: "invoice",
        organizationId: "other",
        userId: "other",
        grantId: "other",
      },
    });
    expect(request).toEqual({ kind: "gmail_search", query: "invoice" });
    expect(result).toMatchObject({
      success: true,
      modelReplyRequired: true,
      data: { actionName: "GOOGLE_CONTEXT", privateSource: true },
    });
  });
  test("limit failures are explicit and diagnostics never include private provider text", async () => {
    const reports: unknown[] = [];
    const runtime = {
      reportError: (...args: unknown[]) => reports.push(args),
    } as unknown as IAgentRuntime;
    let failure: Error = new AgentGoogleConnectorError(
      502,
      "Google Calendar feed exceeded 10000 events; narrow the requested time range.",
    );
    const plugin = createSharedGoogleContextPlugin(async () => {
      throw failure;
    });
    const run = () =>
      plugin.actions![0]!.handler(runtime, {} as Memory, undefined, {
        parameters: { operation: "calendar" },
      });
    expect(await run()).toMatchObject({
      success: false,
      data: { code: "GOOGLE_CONTEXT_LIMIT_EXCEEDED" },
    });
    failure = new Error("private-message-and-token-sentinel");
    const result = await run();
    expect(result).toMatchObject({ success: false, data: { code: "GOOGLE_CONTEXT_UNAVAILABLE" } });
    expect(reports).toHaveLength(2);
    expect(JSON.stringify([reports, result])).not.toContain(failure.message);
    const rejected = await createSharedGoogleContextPlugin(async () =>
      createSharedGoogleReadPort({
        organizationId: "org",
        userId: "owner",
        grantId: "grant",
        authorizePrivateRead: async () => {
          throw new Error("authorization must not run for an invalid request");
        },
      }),
    ).actions![0]!.handler(runtime, {} as Memory, undefined, {
      parameters: {
        operation: "calendar",
        timeMin: "2026-10-08T00:00:00Z",
        timeMax: "2026-10-09T00:00:00Z",
      },
    });
    expect(rejected).toMatchObject({
      success: false,
      data: { code: "GOOGLE_CONTEXT_INVALID_REQUEST" },
    });
  });
});
