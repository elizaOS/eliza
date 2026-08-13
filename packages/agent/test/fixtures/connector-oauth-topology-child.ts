/**
 * Child fixture for the #18080 connector-credential topology e2e: boots the
 * REAL standalone agent entrypoint (`startElizaProcess`, the same boot
 * `packages/agent` `serve`/`start` and the Cloud image's `bin.js start` run —
 * real plugin resolution, real PGlite-backed plugin-sql adapter, real
 * host-bridge/no-op vault, real `ConnectorAccountManager` and Google provider)
 * against the `ELIZA_STATE_DIR` the parent points at, then drives or inspects
 * a Google OAuth flow through the runtime's connector account manager — the
 * deployed completion path on the standalone image, which mounts no
 * personal-assistant HTTP routes. Only Google's token HTTP response is stubbed
 * (parent-owned loopback server via `ELIZA_MOCK_GOOGLE_BASE`).
 *
 * `TOPOLOGY_MODE=connect` runs create-account → startOAuth → completeOAuth and
 * reports the completion outcome; `TOPOLOGY_MODE=inspect` (a fresh process on
 * the same durable state — a full restart) re-reads flow/account state via
 * `TOPOLOGY_STATE`. Results print as one `TOPOLOGY_RESULT=<json>` line.
 */
import { getConnectorAccountManager } from "@elizaos/core";
import { startElizaProcess } from "../../src/runtime/eliza.ts";
import { hasDurableHostVault } from "../../src/runtime/host-bridge.ts";

interface AccountSnapshot {
  id: string;
  status: string;
  hasCredentialRefs: boolean;
  volatile: boolean | null;
}

const mode = process.env.TOPOLOGY_MODE ?? "connect";
const result: Record<string, unknown> = { mode };

try {
  const runtime = await startElizaProcess({ serverOnly: true });
  if (!runtime) throw new Error("startElizaProcess returned no runtime");

  result.hasDurableHostVault = hasDurableHostVault();
  result.storeRegistered = runtime
    .getRegisteredServiceTypes()
    .includes("connector_credential_store" as never);

  const manager = getConnectorAccountManager(runtime);

  // plugin-google-workspace loads in the deferred boot wave, which
  // startElizaProcess does not await; poll until its provider registers.
  const deadline = Date.now() + 120_000;
  while (!manager.getProvider("google")) {
    if (Date.now() > deadline) {
      throw new Error(
        "google connector provider never registered (deferred boot)",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (mode === "connect") {
    const account = await manager.createAccount("google", {
      status: "pending",
    });
    const flow = await manager.startOAuth("google", {
      accountId: account.id,
      scopes: ["gmail.read"],
    });
    result.state = flow.state;
    try {
      const completion = await manager.completeOAuth("google", {
        state: flow.state,
        code: "topology-test-code",
      });
      result.completed = true;
      result.completedAccountStatus = completion.account?.status ?? null;
    } catch (err) {
      result.completed = false;
      result.completionError = err instanceof Error ? err.message : String(err);
      result.completionErrorCode = (err as { code?: string }).code ?? null;
    }
    const after = await manager.getOAuthFlow("google", flow.state);
    result.flowStatus = after?.status ?? null;
    result.flowError = after?.error ?? null;
    result.flowErrorCode = after?.metadata?.errorCode ?? null;
  } else {
    const state = process.env.TOPOLOGY_STATE ?? "";
    const flow = state ? await manager.getOAuthFlow("google", state) : null;
    result.flowStatus = flow?.status ?? null;
    result.flowError = flow?.error ?? null;
    result.flowErrorCode = flow?.metadata?.errorCode ?? null;
  }

  const accounts = await manager.getStorage().listAccounts("google");
  result.accounts = accounts.map((account): AccountSnapshot => {
    const metadata = (account.metadata ?? {}) as {
      credentialRefs?: unknown[];
      credentialRefStorage?: { volatile?: boolean };
    };
    return {
      id: account.id,
      status: account.status,
      hasCredentialRefs:
        Array.isArray(metadata.credentialRefs) &&
        metadata.credentialRefs.length > 0,
      volatile: metadata.credentialRefStorage?.volatile ?? null,
    };
  });
} catch (err) {
  result.driverError = err instanceof Error ? err.message : String(err);
}

console.log(`TOPOLOGY_RESULT=${JSON.stringify(result)}`);
process.exit(result.driverError ? 1 : 0);
