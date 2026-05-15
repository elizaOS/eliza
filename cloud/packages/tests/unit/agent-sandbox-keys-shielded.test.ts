/**
 * Sandbox-scoped API keys (name prefix `agent-sandbox:`) are lifecycle-owned
 * by the provisioner (`createForAgent` / `revokeForAgent`). They must never
 * appear in the user-facing API key list, and the dashboard delete /
 * regenerate / patch endpoints must refuse to act on them. Otherwise a user
 * could revoke a key their own running agent depends on, breaking inference
 * until the sandbox is re-provisioned.
 */

import { describe, expect, test } from "bun:test";
import type { ApiKey } from "@/db/repositories";
import { ApiKeysService } from "@/lib/services/api-keys";

function buildKey(name: string): ApiKey {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    name,
    description: null,
    key: "eliza_secret",
    key_hash: "hash",
    key_prefix: "eliza_se",
    organization_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    permissions: [],
    rate_limit: 1000,
    is_active: true,
    usage_count: 0,
    expires_at: null,
    last_used_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("ApiKeysService.isAgentSandboxKey", () => {
  test("returns true for the canonical sandbox name shape", () => {
    expect(
      ApiKeysService.isAgentSandboxKey(
        buildKey("agent-sandbox:c7088b34-2b4b-41de-91a8-e69a1a4b8622"),
      ),
    ).toBe(true);
  });

  test("returns false for user-created keys with descriptive names", () => {
    expect(
      ApiKeysService.isAgentSandboxKey(buildKey("My Production Key")),
    ).toBe(false);
    expect(ApiKeysService.isAgentSandboxKey(buildKey("CI"))).toBe(false);
    expect(ApiKeysService.isAgentSandboxKey(buildKey("explorer"))).toBe(false);
  });

  test("does not match when the prefix appears mid-string", () => {
    expect(
      ApiKeysService.isAgentSandboxKey(buildKey("my-agent-sandbox:foo")),
    ).toBe(false);
  });

  test("matches the bare prefix (defensive — provisioner always appends an id)", () => {
    // Prefix-only is a malformed name we should still treat as sandbox-owned
    // so a corrupted row cannot be deleted from the dashboard.
    expect(ApiKeysService.isAgentSandboxKey(buildKey("agent-sandbox:"))).toBe(
      true,
    );
  });

  test("AGENT_KEY_NAME_PREFIX constant is the static source of truth", () => {
    expect(ApiKeysService.AGENT_KEY_NAME_PREFIX).toBe("agent-sandbox:");
  });
});

describe("Agent sandbox keys excluded from dashboard listing", () => {
  test("filter drops every key whose name starts with the sandbox prefix", () => {
    const userKeyA = buildKey("My Production Key");
    const userKeyB = buildKey("CI");
    const sandboxKeyA = buildKey(
      "agent-sandbox:c7088b34-2b4b-41de-91a8-e69a1a4b8622",
    );
    const sandboxKeyB = buildKey(
      "agent-sandbox:5710d11d-aaaa-bbbb-cccc-dddddddddddd",
    );

    const stored = [userKeyA, sandboxKeyA, userKeyB, sandboxKeyB];
    const visible = stored.filter(
      (key) => !ApiKeysService.isAgentSandboxKey(key),
    );

    expect(visible).toEqual([userKeyA, userKeyB]);
  });

  test("filter is a no-op when no sandbox keys exist", () => {
    const stored = [buildKey("My Production Key"), buildKey("CI")];
    const visible = stored.filter(
      (key) => !ApiKeysService.isAgentSandboxKey(key),
    );
    expect(visible).toEqual(stored);
  });

  test("filter returns empty array when every key is sandbox-managed", () => {
    const stored = [
      buildKey("agent-sandbox:c7088b34-2b4b-41de-91a8-e69a1a4b8622"),
      buildKey("agent-sandbox:5710d11d-aaaa-bbbb-cccc-dddddddddddd"),
    ];
    const visible = stored.filter(
      (key) => !ApiKeysService.isAgentSandboxKey(key),
    );
    expect(visible).toEqual([]);
  });
});
