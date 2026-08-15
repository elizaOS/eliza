/**
 * Child fixture for the #18080 durable connector-credential e2e: boots the
 * REAL standalone agent entrypoint (`startElizaProcess`, the same boot the
 * Cloud image's `bin.js start` runs — real plugin resolution, real
 * PGlite-backed plugin-sql adapter, no app-core host bridge installed)
 * against the `ELIZA_STATE_DIR` the parent points at.
 *
 * `DURABLE_MODE=write` proves a durable writer exists on a hostless boot: it
 * resolves the runtime-registered `connector_credential_store`, creates a
 * REAL google connector account, and persists a token through the plugin's
 * `persistConnectorCredentialRefs` — the exact write `completeOAuth` performs
 * on the standalone image. `DURABLE_MODE=read` (a fresh process on the same
 * durable state — a full restart) re-resolves the store under the same
 * service name the credential resolver probes and reveals the credential.
 * Results print as one `DURABLE_RESULT=<json>` line.
 */
import { getConnectorAccountManager } from "@elizaos/core";
import {
  credentialRefRecordsFromMetadata,
  persistConnectorCredentialRefs,
} from "../../../../plugins/plugin-google-workspace/src/connector-credential-refs.ts";
import { startElizaProcess } from "../../src/runtime/eliza.ts";

const mode = process.env.DURABLE_MODE ?? "write";
const result: Record<string, unknown> = { mode };

try {
  const runtime = await startElizaProcess({ serverOnly: true });
  if (!runtime) throw new Error("startElizaProcess returned no runtime");

  const store = runtime.getService("connector_credential_store" as never) as {
    putSecret?: unknown;
    reveal?: (ref: string, caller?: string) => Promise<string>;
  } | null;
  result.storeRegistered = Boolean(
    store && typeof store.putSecret === "function",
  );

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

  if (mode === "write") {
    // The token comes through runtime.getSetting (which deliberately never
    // reads process.env); the parent seeds it into the state dir's
    // eliza.json agent settings alongside the Google client config.
    const tokenValue = runtime.getSetting("DURABLE_TOKEN_VALUE");
    if (typeof tokenValue !== "string" || tokenValue.length === 0) {
      throw new Error(
        "DURABLE_TOKEN_VALUE missing from agent settings (eliza.json)",
      );
    }
    const account = await manager.createAccount("google", {
      status: "pending",
    });
    const persisted = await persistConnectorCredentialRefs({
      runtime,
      manager,
      provider: "google",
      accountIdForRef: account.id,
      storageAccountId: account.id,
      caller: "durable-e2e",
      credentials: [
        {
          credentialType: "oauth.tokens",
          value: tokenValue,
        },
      ],
    });
    result.accountId = account.id;
    result.vaultRef = persisted.refs[0]?.vaultRef ?? null;
  } else {
    const accountId = process.env.DURABLE_ACCOUNT_ID ?? "";
    const vaultRef = process.env.DURABLE_VAULT_REF ?? "";
    // persistConnectorCredentialRefs records the ref through the first
    // candidate exposing setConnectorAccountCredentialRef — the SQL database
    // adapter on this boot. Read the surviving row back from the same
    // adapter, plus any metadata-carried refs on the account itself.
    const adapter = (
      runtime as unknown as {
        adapter?: {
          listConnectorAccountCredentialRefs?: (params: {
            accountId: string;
          }) => Promise<Array<{ credentialType: string; vaultRef: string }>>;
        };
      }
    ).adapter;
    const account = await manager.getStorage().getAccount("google", accountId);
    result.refs = [
      ...((await adapter?.listConnectorAccountCredentialRefs?.({
        accountId,
      })) ?? []),
      ...(account ? credentialRefRecordsFromMetadata(account.metadata) : []),
    ];
    if (!store || typeof store.reveal !== "function") {
      throw new Error("connector_credential_store missing after restart");
    }
    result.value = await store.reveal(vaultRef, "durable-e2e");
  }
} catch (err) {
  result.driverError = err instanceof Error ? err.message : String(err);
  result.driverErrorCode = (err as { code?: string }).code ?? null;
}

console.log(`DURABLE_RESULT=${JSON.stringify(result)}`);
process.exit(result.driverError ? 1 : 0);
