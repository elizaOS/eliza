/**
 * Agent-scoped GitHub credential storage against the real encrypted test vault.
 * The suite covers durable reads, cross-agent isolation, independent rotation,
 * encrypted-at-rest bytes, and corrupt binding rejection.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { createTestVault, type TestVault } from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCredentialsFromUserResponse,
  githubCredentialVaultKey,
  VaultGitHubCredentialStore,
} from "./github-credentials.js";
import { hydrateRuntimeGitHubCredential } from "./github-route-adapter.js";

let testVault: TestVault;

beforeEach(async () => {
  testVault = await createTestVault();
});

afterEach(async () => {
  await testVault.dispose();
});

async function allFileBytes(root: string): Promise<Buffer> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) chunks.push(await allFileBytes(target));
    else if (entry.isFile()) chunks.push(await fs.readFile(target));
  }
  return Buffer.concat(chunks);
}

describe("VaultGitHubCredentialStore", () => {
  it("keeps two agents isolated through save, restart hydration, rotation, and clear", async () => {
    const store = new VaultGitHubCredentialStore(testVault.vault);
    const agentA = "00000000-0000-4000-8000-00000000000a";
    const agentB = "00000000-0000-4000-8000-00000000000b";
    const credentialA = buildCredentialsFromUserResponse(
      "gho_agent_a",
      { login: "agent-a" },
      ["repo"],
      100,
    );
    const credentialB = buildCredentialsFromUserResponse(
      "gho_agent_b",
      { login: "agent-b" },
      ["read:user"],
      200,
    );

    await Promise.all([
      store.save(agentA, credentialA),
      store.save(agentB, credentialB),
    ]);
    expect(githubCredentialVaultKey(agentA)).not.toBe(
      githubCredentialVaultKey(agentB),
    );

    // A new store instance models runtime/plugin restart hydration from the
    // same durable vault rather than retaining an in-memory token.
    const afterRestart = new VaultGitHubCredentialStore(testVault.vault);
    await expect(afterRestart.load(agentA)).resolves.toEqual(credentialA);
    await expect(afterRestart.load(agentB)).resolves.toEqual(credentialB);

    await afterRestart.save(
      agentA,
      buildCredentialsFromUserResponse(
        "gho_agent_a_rotated",
        { login: "agent-a" },
        ["repo", "read:user"],
        300,
      ),
    );
    await expect(afterRestart.load(agentB)).resolves.toEqual(credentialB);
    await afterRestart.clear(agentA);
    await expect(afterRestart.load(agentA)).resolves.toBeNull();
    await expect(afterRestart.load(agentB)).resolves.toEqual(credentialB);
  });

  it("marks records sensitive and never writes the token into vault files", async () => {
    const store = new VaultGitHubCredentialStore(testVault.vault);
    const agent = "00000000-0000-4000-8000-00000000000a";
    const token = "gho_plaintext_must_not_exist_on_disk_15904";
    await store.save(
      agent,
      buildCredentialsFromUserResponse(token, { login: "octocat" }, ["repo"]),
    );

    const descriptor = await testVault.vault.describe(
      githubCredentialVaultKey(agent),
    );
    expect(descriptor?.sensitive).toBe(true);
    const bytes = await allFileBytes(testVault.dataDir);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
  });

  it("rejects an encrypted envelope bound to a different agent", async () => {
    const agentA = "agent-a";
    const key = githubCredentialVaultKey(agentA);
    await testVault.vault.set(
      key,
      JSON.stringify({
        version: 1,
        agentKey: "agent-b",
        credentials: buildCredentialsFromUserResponse(
          "gho_wrong_owner",
          { login: "wrong" },
          [],
        ),
      }),
      { sensitive: true },
    );
    const store = new VaultGitHubCredentialStore(testVault.vault);
    await expect(store.load(agentA)).rejects.toMatchObject({
      code: "GITHUB_CREDENTIAL_CORRUPT",
    });
  });

  it("hydrates only the matching runtime on restart without touching process env", async () => {
    const store = new VaultGitHubCredentialStore(testVault.vault);
    await store.save(
      "agent-a",
      buildCredentialsFromUserResponse("gho_agent_a", { login: "agent-a" }, [
        "repo",
      ]),
    );
    const makeRuntime = (
      agentId: string,
    ): Pick<IAgentRuntime, "agentId" | "setSetting"> & {
      secrets: Record<string, string>;
    } => {
      const secrets: Record<string, string> = {};
      return {
        agentId,
        setSetting(key: string, value: string | boolean | null) {
          if (value !== null) secrets[key] = String(value);
        },
        secrets,
      };
    };
    const runtimeA = makeRuntime("agent-a");
    const runtimeB = makeRuntime("agent-b");
    const priorHostToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "host-token";
    try {
      await hydrateRuntimeGitHubCredential(runtimeA, store);
      await hydrateRuntimeGitHubCredential(runtimeB, store);
      expect(runtimeA.secrets.GITHUB_TOKEN).toBe("gho_agent_a");
      expect(runtimeB.secrets.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.GITHUB_TOKEN).toBe("host-token");
    } finally {
      if (priorHostToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = priorHostToken;
    }
  });
});
