import type { IAgentRuntime, UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import type { AccessRequest, PermissionDecision } from "../types/permissions";
import { ContextualPermissionSystem } from "./ContextualPermissionSystem";
import type { SecurityModule } from "./SecurityModule";
import type { TrustEngine } from "./TrustEngine";

it("a revoked delegation cannot repopulate the permission cache from an in-flight check", async () => {
  const owner = "11111111-1111-4111-8111-111111111111" as UUID;
  const entity = "22222222-2222-4222-8222-222222222222" as UUID;
  const delegation = "33333333-3333-4333-8333-333333333333" as UUID;
  const system = new ContextualPermissionSystem();
  await system.initialize(
    { agentId: owner } as IAgentRuntime,
    {} as TrustEngine,
    {
      detectPromptInjection: async () => ({ detected: false }),
    } as unknown as SecurityModule,
  );
  const request: AccessRequest = {
    entityId: entity,
    action: "custom_export",
    resource: "document:one",
    context: {},
  };
  system.addDelegation({
    id: delegation,
    delegatorId: owner,
    delegateeId: entity,
    permissions: [{ action: request.action, resource: request.resource }],
    context: {},
    createdAt: Date.now(),
  });
  const probe = system as unknown as {
    checkDelegatedPermissions(
      request: AccessRequest,
    ): Promise<PermissionDecision>;
  };
  const original = probe.checkDelegatedPermissions.bind(system);
  let resume!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(probe, "checkDelegatedPermissions").mockImplementationOnce(
    async (value) => {
      const decision = await original(value);
      reached();
      await gate;
      return decision;
    },
  );
  const pending = system.checkAccess(request);
  await entered;
  expect(system.revokeDelegation(delegation, owner)).toBe(true);
  resume();
  await pending;
  expect((await system.checkAccess(request)).allowed).toBe(false);
});
