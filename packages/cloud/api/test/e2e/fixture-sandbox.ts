/**
 * Maintains the inert sandbox rows used to exercise ownership and billing APIs.
 * These records deliberately have no runtime endpoint: advertising them as
 * running would make background health and backup scanners treat test fixtures
 * as live agents.
 */

import type {
  AgentSandbox,
  NewAgentSandbox,
} from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";

export interface FixtureSandboxRepository {
  create(data: NewAgentSandbox): Promise<unknown>;
  update(
    id: string,
    data: Partial<NewAgentSandbox>,
  ): Promise<{ id: string } | undefined>;
}

export type FixtureSandboxRecord = Pick<
  AgentSandbox,
  "id" | "sandbox_id" | "status" | "bridge_url" | "health_url"
>;

interface EnsureFixtureSandboxOptions {
  slug: string;
  organizationId: string;
  userId: string;
  sandboxes: FixtureSandboxRecord[];
  repository: FixtureSandboxRepository;
}

const INERT_FIXTURE_STATE = {
  status: "stopped",
  bridge_url: null,
  health_url: null,
} as const;

export async function ensureFixtureSandbox({
  slug,
  organizationId,
  userId,
  sandboxes,
  repository,
}: EnsureFixtureSandboxOptions): Promise<void> {
  const sandboxId = `${slug}-sandbox`;
  const fixture = sandboxes.find((sandbox) => sandbox.sandbox_id === sandboxId);

  if (!fixture) {
    await repository.create({
      organization_id: organizationId,
      user_id: userId,
      sandbox_id: sandboxId,
      agent_name: `${slug} test agent`,
      database_status: "ready",
      environment_vars: {},
      ...INERT_FIXTURE_STATE,
    });
    return;
  }

  if (
    fixture.status === INERT_FIXTURE_STATE.status &&
    fixture.bridge_url === INERT_FIXTURE_STATE.bridge_url &&
    fixture.health_url === INERT_FIXTURE_STATE.health_url
  ) {
    return;
  }

  const updated = await repository.update(fixture.id, INERT_FIXTURE_STATE);
  if (!updated) {
    throw new Error(
      `E2E fixture sandbox disappeared while normalizing it: ${fixture.id}`,
    );
  }
}
