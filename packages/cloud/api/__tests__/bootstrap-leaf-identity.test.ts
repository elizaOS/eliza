/** Proves the bootstrap leaves retain the cached SDK's actual helper identities and storage UUIDs. */
import { describe, expect, test } from "bun:test";
import * as coreEdge from "@elizaos/core/edge";
import { ElizaError } from "@elizaos/core/errors";
import {
  isBlockedHostname,
  isPrivateIpAddress,
} from "@elizaos/core/network/ssrf";
import {
  isSensitiveKeyName,
  redactLogArgs,
} from "@elizaos/core/security/redact";
import { ChannelType } from "@elizaos/core/types/primitives";
import { stringToUuid } from "@elizaos/core/utils";
import { parseSharedRuntimeChannel } from "@/lib/services/shared-runtime/shared-runtime-channel";
import {
  sharedRuntimeConversationRoomId,
  sharedRuntimeWorldId,
  sharedTodoStorageScope,
} from "@/lib/services/shared-runtime/shared-runtime-storage-identity";
import { TwitterOAuthRefreshCoordinator } from "../src/twitter-oauth-refresh-coordinator";

describe("bootstrap canonical leaf boundaries", () => {
  test("uses the same SDK functions and channel enum, without copies or substitutes", () => {
    expect(ElizaError).toBe(coreEdge.ElizaError);
    expect(isBlockedHostname).toBe(coreEdge.isBlockedHostname);
    expect(isPrivateIpAddress).toBe(coreEdge.isPrivateIpAddress);
    expect(isSensitiveKeyName).toBe(coreEdge.isSensitiveKeyName);
    expect(redactLogArgs).toBe(coreEdge.redactLogArgs);
    expect(ChannelType).toBe(coreEdge.ChannelType);
    expect(stringToUuid).toBe(coreEdge.stringToUuid);
  });

  test("retains stable conversation, world and Todo tenant identities", () => {
    const agent = "bootstrap-agent-example";
    const owner = "bootstrap-owner-example";
    expect(sharedRuntimeConversationRoomId(agent)).toBe(
      coreEdge.stringToUuid(`${agent}:conversation`),
    );
    expect(sharedRuntimeWorldId(agent)).toBe(
      coreEdge.stringToUuid(`${agent}:world`),
    );
    expect(
      sharedTodoStorageScope({ sourceAgentId: agent, ownerId: owner }),
    ).toEqual({
      agentId: coreEdge.stringToUuid(`shared-todos:agent:${agent}`),
      entityId: coreEdge.stringToUuid(`shared-todos:owner:${owner}`),
    });
    expect(() => sharedRuntimeConversationRoomId(" ")).toThrow(ElizaError);
  });

  test("retains channel validation, sensitive-key redaction and SSRF refusal", () => {
    expect(
      parseSharedRuntimeChannel({ type: ChannelType.DM, source: "telegram" }),
    ).toEqual({
      type: ChannelType.DM,
      source: "telegram",
    });
    expect(
      parseSharedRuntimeChannel({ type: "untrusted", source: "telegram" }),
    ).toBeNull();
    expect(isSensitiveKeyName("authorization")).toBe(true);
    expect(
      redactLogArgs([{ apiKey: "local-fixture-secret-1234567890" }]),
    ).toEqual(
      coreEdge.redactLogArgs([{ apiKey: "local-fixture-secret-1234567890" }]),
    );
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isPrivateIpAddress("127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("8.8.8.8")).toBe(false);
    expect(TwitterOAuthRefreshCoordinator.length).toBe(2);
  });
});
