/** IMESSAGE_ALLOW_FROM entries match sender handles after the contacts normalization. */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { IMessageService } from "./service.js";
import type { IMessageSettings } from "./types.js";

function service(allowFrom: string[]) {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
  } as unknown as IAgentRuntime;
  const instance = new IMessageService(runtime);
  const internal = instance as unknown as {
    settings: IMessageSettings;
    checkDmAccess(handle: string): Promise<{ allowed: boolean }>;
    checkGroupAccess(handle: string): { allowed: boolean };
  };
  internal.settings = {
    transport: "native",
    pollIntervalMs: 0,
    heartbeatIntervalMs: 60000,
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom,
    enabled: true,
  } as IMessageSettings;
  return internal;
}

it.each([
  ["+1 (555) 123-4567", "+15551234567"],
  ["15551234567", "+15551234567"],
  ["+1-555-123-4567", "+15551234567"],
  ["Owner@iCloud.com", "owner@icloud.com"],
])("an allowlist entry %s admits the sender %s", async (entry, handle) => {
  const internal = service([entry]);
  expect(await internal.checkDmAccess(handle)).toMatchObject({ allowed: true });
  expect(internal.checkGroupAccess(handle)).toEqual({ allowed: true });
});

it("a different number stays outside the allowlist", async () => {
  const internal = service(["+15551234567"]);
  expect(await internal.checkDmAccess("+15557654321")).toMatchObject({ allowed: false });
  expect(internal.checkGroupAccess("+15557654321")).toEqual({ allowed: false });
});
