/**
 * AC4 (#8898): the independent verifier's read/search/execute capability and
 * direct edit/write/delete denial are enforced at the native transport.
 *
 * `isOperationApproved` is the gate every ACP client method consults:
 * `writeTextFile` throws `PermissionDeniedError` when `!isOperationApproved("edit")`,
 * `createTerminal` when `!isOperationApproved("execute")`, and `readTextFile` when
 * `!isOperationApproved("read")`. The public `approvesPermissionRequest` mirrors
 * that exact decision (`isOperationApproved(inferToolKind(toolCall))`). Under
 * `verifier`, read/search/execute are approved (the verifier can run `bun test`,
 * `git diff`, and read files), while direct ACP edit/write/delete operations are
 * denied. Execute is intentionally not a filesystem sandbox.
 */

import { describe, expect, it } from "vitest";
import { NativeAcpClient } from "../services/acp-native-transport";
import type { ApprovalPreset } from "../services/types";

function makeClient(approvalPreset: ApprovalPreset): NativeAcpClient {
  return new NativeAcpClient({
    command: "true",
    cwd: "/tmp",
    mcpServers: [],
    approvalPreset,
  });
}

interface RequestCall {
  method: string;
  params: unknown;
}

interface StubSessionModes {
  currentModeId: string;
  availableModeIds: readonly string[];
}

function stubSessionHandshake(
  client: NativeAcpClient,
  modes?: StubSessionModes,
): RequestCall[] {
  const calls: RequestCall[] = [];
  const request = async (method: string, params: unknown): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "session/new") {
      return {
        sessionId: "session-1",
        ...(modes
          ? {
              modes: {
                currentModeId: modes.currentModeId,
                availableModes: modes.availableModeIds.map((id) => ({ id })),
              },
            }
          : {}),
      };
    }
    return {};
  };
  (client as unknown as { request: typeof request }).request = request;
  return calls;
}

const OPTIONS = [
  { kind: "allow_once", optionId: "allow" },
  { kind: "reject_once", optionId: "reject" },
];

function approves(client: NativeAcpClient, kind: string): boolean {
  return client.approvesPermissionRequest({
    toolCall: { kind },
    options: OPTIONS,
  });
}

describe("acp-native-transport approval preset 'verifier' (#8898 AC4)", () => {
  it("approves read, search, and execute", () => {
    const client = makeClient("verifier");
    expect(approves(client, "read")).toBe(true);
    expect(approves(client, "search")).toBe(true);
    expect(approves(client, "execute")).toBe(true);
  });

  it("denies direct edit, write, and delete operations", () => {
    const client = makeClient("verifier");
    expect(approves(client, "edit")).toBe(false);
    expect(approves(client, "write")).toBe(false);
    expect(approves(client, "delete")).toBe(false);
  });

  it("differs from 'standard' (which denies execute) and 'readonly' (which denies all)", () => {
    // Contrast: only `verifier` grants execute while denying direct write kinds.
    const standard = makeClient("standard");
    expect(approves(standard, "execute")).toBe(false);
    expect(approves(standard, "read")).toBe(true);
    expect(approves(standard, "edit")).toBe(false);

    const readonly = makeClient("readonly");
    expect(approves(readonly, "read")).toBe(false);
    expect(approves(readonly, "execute")).toBe(false);
  });
});

describe("acp-native-transport session mode negotiation", () => {
  const advertisedModes = ["bypassPermissions", "plan", "dontAsk", "default"];

  it.each<{
    approvalPreset: ApprovalPreset;
    expectedModeId: string;
  }>([
    { approvalPreset: "autonomous", expectedModeId: "bypassPermissions" },
    { approvalPreset: "permissive", expectedModeId: "bypassPermissions" },
    { approvalPreset: "readonly", expectedModeId: "plan" },
    { approvalPreset: "standard", expectedModeId: "dontAsk" },
    { approvalPreset: "verifier", expectedModeId: "default" },
  ])(
    "selects $expectedModeId for $approvalPreset",
    async ({ approvalPreset, expectedModeId }) => {
      const client = makeClient(approvalPreset);
      const calls = stubSessionHandshake(client, {
        currentModeId: "dontAsk",
        availableModeIds: advertisedModes,
      });

      await client.createSession();

      expect(
        calls.filter(({ method }) => method === "session/set_mode"),
      ).toEqual([
        {
          method: "session/set_mode",
          params: { sessionId: "session-1", modeId: expectedModeId },
        },
      ]);
    },
  );

  it("keeps the agent fallback when modes are absent", async () => {
    const client = makeClient("verifier");
    const calls = stubSessionHandshake(client);

    await client.createSession();

    expect(calls.filter(({ method }) => method === "session/set_mode")).toEqual(
      [],
    );
  });

  it("selects read-only for Codex-shaped verifier modes", async () => {
    const client = makeClient("verifier");
    const calls = stubSessionHandshake(client, {
      currentModeId: "agent",
      availableModeIds: ["read-only", "agent", "agent-full-access"],
    });

    await client.createSession();

    expect(calls.filter(({ method }) => method === "session/set_mode")).toEqual(
      [
        {
          method: "session/set_mode",
          params: { sessionId: "session-1", modeId: "read-only" },
        },
      ],
    );
  });

  it.each([
    {
      currentModeId: "bypassPermissions",
      availableModeIds: ["bypassPermissions", "dontAsk"],
    },
    {
      currentModeId: "acceptEdits",
      availableModeIds: ["acceptEdits", "dontAsk"],
    },
    {
      currentModeId: "dontAsk",
      availableModeIds: ["dontAsk"],
    },
  ])(
    "rejects unsupported verifier mode state $currentModeId",
    async ({ currentModeId, availableModeIds }) => {
      const client = makeClient("verifier");
      const calls = stubSessionHandshake(client, {
        currentModeId,
        availableModeIds,
      });

      await expect(client.createSession()).rejects.toThrow(
        `ACP verifier requires an advertised permission-requesting mode ("read-only" or "default"); current mode is "${currentModeId}"`,
      );
      expect(
        calls.filter(({ method }) => method === "session/set_mode"),
      ).toEqual([]);
    },
  );
});
