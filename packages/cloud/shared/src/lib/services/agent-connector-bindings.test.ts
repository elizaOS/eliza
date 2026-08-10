/**
 * Deterministic service contract tests for credential-free agent connector
 * bindings. The database boundary is faked; tenant and ownership enforcement is
 * separately exercised by repository integration tests.
 */

import { describe, expect, test } from "bun:test";
import type { AgentConnectorBinding } from "@elizaos/core";
import type {
  AgentConnectorExecutionBinding,
  BindAgentConnectorInput,
} from "../../db/repositories/agent-connector-bindings";
import {
  AgentConnectorBindingRepositoryError,
  AgentConnectorBindingsRepository,
} from "../../db/repositories/agent-connector-bindings";
import { createAgentConnectorBindingsService } from "./agent-connector-bindings";

const NOW = Date.parse("2026-08-10T00:00:00Z");

function publicBinding(overrides: Partial<AgentConnectorBinding> = {}): AgentConnectorBinding {
  return {
    id: "binding-1",
    agentId: "agent-1",
    provider: "google",
    role: "OWNER",
    purposes: ["automation"],
    accessGate: "owner_binding",
    status: "connected",
    selectedProducts: ["gmail", "calendar"],
    allowedCapabilities: ["gmail.read", "calendar.read"],
    grantedScopes: ["scope-a"],
    externalIdentity: { id: "google-user-1", displayHandle: "ada@example.com" },
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeRepository extends AgentConnectorBindingsRepository {
  bindCalls: BindAgentConnectorInput[] = [];
  result = publicBinding();
  bindError: Error | null = null;

  override async bind(input: BindAgentConnectorInput): Promise<AgentConnectorBinding> {
    this.bindCalls.push(input);
    if (this.bindError) throw this.bindError;
    return this.result;
  }

  override async list(): Promise<AgentConnectorBinding[]> {
    return [this.result];
  }

  override async getExecutionBinding(): Promise<AgentConnectorExecutionBinding | null> {
    return {
      binding: this.result,
      organizationId: "org-1",
      platformCredentialId: "credential-private-1",
      credentialStatus: "active",
    };
  }
}

function containsForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|vault|credential|connectionid/i.test(key)) return true;
    if (containsForbiddenKey(child)) return true;
  }
  return false;
}

describe("agent connector binding service", () => {
  test("normalizes a direct binding without leaking a credential locator", async () => {
    const repository = new FakeRepository();
    const service = createAgentConnectorBindingsService({ repository });

    const result = await service.bind({
      organizationId: "org-1",
      agentId: "agent-1",
      platformCredentialId: "credential-private-1",
      provider: "GOOGLE",
      role: "OWNER",
      selectedProducts: ["gmail", "calendar", "gmail"],
      isDefault: true,
      authorizedByUserId: "user-1",
    });

    expect(containsForbiddenKey(result)).toBe(false);
    expect(repository.bindCalls).toEqual([
      expect.objectContaining({
        provider: "google",
        requireVerifiedOwner: true,
        selectedProducts: ["gmail", "calendar"],
      }),
    ]);
  });

  test("maps verified-owner failures to a stable forbidden boundary", async () => {
    const repository = new FakeRepository();
    repository.bindError = new AgentConnectorBindingRepositoryError(
      "OWNER_NOT_VERIFIED",
      "OWNER binding rejected.",
    );
    const service = createAgentConnectorBindingsService({ repository });

    await expect(
      service.bind({
        organizationId: "org-1",
        agentId: "agent-1",
        platformCredentialId: "credential-other",
        provider: "google",
        role: "OWNER",
        selectedProducts: ["gmail"],
        authorizedByUserId: "user-1",
      }),
    ).rejects.toMatchObject({ status: 403, code: "OWNER_NOT_VERIFIED" });
  });

  test("defers product canonicalization to the repository boundary", async () => {
    const repository = new FakeRepository();
    const service = createAgentConnectorBindingsService({ repository });

    await service.bind({
      organizationId: "org-1",
      agentId: "agent-1",
      platformCredentialId: "credential-private-1",
      provider: "google",
      role: "OWNER",
      selectedProducts: [" workspace "],
      authorizedByUserId: "user-1",
    });

    // The repository owns "workspace" → "universalSearch" canonicalization so
    // direct repository callers (OAuth storeConnection) share it; the service
    // only trims and de-duplicates.
    expect(repository.bindCalls[0]?.selectedProducts).toEqual(["workspace"]);
  });
});
