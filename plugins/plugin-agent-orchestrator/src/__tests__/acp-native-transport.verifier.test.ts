/**
 * AC4 (#8898): the independent verifier's read-only-but-executable capability is
 * enforced at the native transport, not by prompt text.
 *
 * `isOperationApproved` is the single gate every dangerous client method consults:
 * `writeTextFile` throws `PermissionDeniedError` when `!isOperationApproved("edit")`,
 * `createTerminal` when `!isOperationApproved("execute")`, and `readTextFile` when
 * `!isOperationApproved("read")`. The public `approvesPermissionRequest` mirrors
 * that exact decision (`isOperationApproved(inferToolKind(toolCall))`), so asserting
 * it proves the hard enforcement: under `verifier`, read/search/execute are approved
 * (the verifier can run `bun test`, `git diff`, and read files) while edit/write/delete
 * are denied (any write physically throws off the same gate).
 */

import { describe, expect, it } from "vitest";
import { NativeAcpClient } from "../services/acp-native-transport";
import type { ApprovalPreset } from "../services/types";

function makeClient(approvalPreset: ApprovalPreset): NativeAcpClient {
  return new NativeAcpClient({
    command: "true",
    cwd: "/tmp",
    approvalPreset,
  });
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

  it("denies edit, write, and delete (read-only enforced at the transport)", () => {
    const client = makeClient("verifier");
    expect(approves(client, "edit")).toBe(false);
    expect(approves(client, "write")).toBe(false);
    expect(approves(client, "delete")).toBe(false);
  });

  it("differs from 'standard' (which denies execute) and 'readonly' (which denies all)", () => {
    // Contrast: only `verifier` grants execute while still denying writes.
    const standard = makeClient("standard");
    expect(approves(standard, "execute")).toBe(false);
    expect(approves(standard, "read")).toBe(true);
    expect(approves(standard, "edit")).toBe(false);

    const readonly = makeClient("readonly");
    expect(approves(readonly, "read")).toBe(false);
    expect(approves(readonly, "execute")).toBe(false);
  });
});
