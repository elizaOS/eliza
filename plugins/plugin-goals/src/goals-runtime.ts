/**
 * Standalone {@link GoalsService} construction for the plugin-goals action and
 * routes, with default hooks for the owner-scoped surface.
 *
 * The two PA-owned concerns the service needs are reproduced here for the
 * PA-free deployment topology:
 *   - `normalizeOwnership` — the action drives the owner surface (ADMIN role,
 *     owner contexts), so goals are always owner-scoped. We return the fixed
 *     owner ownership (`user_lifeops` / `owner` / `owner_only` /
 *     `explicit_only`, subjectId = the agent's admin entity) that PA's
 *     `normalizeOwnership` produces for the owner case.
 *   - `recordAudit` — writes the goal audit event into PA's shared
 *     `app_lifeops.life_audit_events` table via {@link GoalsRepository}.
 *
 * When PA is loaded it constructs the {@link GoalsService} with its own
 * `recordAudit` / `normalizeOwnership` bound from the LifeOps service base, so
 * the agent-scoped path and PA's domain invariants stay intact.
 */

import crypto from "node:crypto";
import { type IAgentRuntime, stringToUuid } from "@elizaos/core";
import type { LifeOpsOwnership } from "@elizaos/shared";
import { GoalsRepository } from "./db/goals-repository.ts";
import { requireAgentId } from "./goal-normalize.ts";
import {
  type GoalsNormalizeOwnership,
  type GoalsRecordAudit,
  GoalsService,
} from "./goals-service.ts";
import { getGoalsCheckinService } from "./services/checkin.ts";

/** Owner-entity id PA derives for the admin/owner entity of an agent. */
export function ownerEntityIdFor(runtime: IAgentRuntime): string {
  return stringToUuid(`${requireAgentId(runtime)}-admin-entity`);
}

/**
 * Fixed owner-scope ownership. Matches the result of PA's `normalizeOwnership`
 * for an owner request with no explicit overrides.
 */
export function buildOwnerOwnership(runtime: IAgentRuntime): LifeOpsOwnership {
  return {
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: ownerEntityIdFor(runtime),
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
  };
}

/**
 * Construct a {@link GoalsService} bound to the owner surface with default
 * hooks, for use without `@elizaos/plugin-personal-assistant`.
 */
export function createOwnerGoalsService(runtime: IAgentRuntime): GoalsService {
  const repository = new GoalsRepository(runtime);

  const normalizeOwnership: GoalsNormalizeOwnership = () =>
    buildOwnerOwnership(runtime);

  const recordAudit: GoalsRecordAudit = async (
    eventType,
    ownerType,
    ownerId,
    reason,
    inputs,
    decision,
  ) => {
    await repository.createAuditEvent({
      id: crypto.randomUUID(),
      agentId: requireAgentId(runtime),
      eventType,
      ownerType,
      ownerId,
      reason,
      inputs,
      decision,
      actor: "user",
      createdAt: new Date().toISOString(),
    });
  };

  return new GoalsService(runtime, {
    recordAudit,
    normalizeOwnership,
    checkinSync: () => getGoalsCheckinService(runtime),
  });
}
