/**
 * Telegram ConnectorAccountManager provider.
 *
 * Bridges plugin-telegram to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD surface can list, create, patch, and delete Telegram
 * accounts. Telegram bots authenticate via a long-lived bot token (no OAuth);
 * `startOAuth` / `completeOAuth` are intentionally not implemented.
 *
 * Single-account env-only configurations (TELEGRAM_BOT_TOKEN) are surfaced as
 * a synthesized 'default' account with role 'AGENT' so downstream consumers
 * see a uniform list. Multi-account configs declared on character.settings.telegram
 * are surfaced verbatim from manager-owned storage.
 */
import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledTelegramAccounts,
  resolveTelegramAccount,
} from "./accounts";
import { TELEGRAM_SERVICE_NAME } from "./constants";

function nowMs(): number {
  return Date.now();
}

/**
 * Build a synthetic ConnectorAccount for a resolved Telegram account that has
 * a usable bot token (i.e. a working single-account config from environment
 * variables or character.settings.telegram).
 */
function synthesizeAccount(
  accountId: string,
  name: string | undefined,
  externalId: string | undefined,
): ConnectorAccount {
  return {
    id: accountId,
    provider: TELEGRAM_SERVICE_NAME,
    label: name ?? `Telegram (${accountId})`,
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId,
    displayHandle: name,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    metadata: {
      synthesized: true,
      source: "env",
    },
  };
}

export function createTelegramConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: TELEGRAM_SERVICE_NAME,
    label: "Telegram",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      // Merge persisted accounts (from manager storage) with synthesized
      // accounts from env/character config. The persisted set wins on id
      // collision so explicit overrides survive.
      const persisted = await manager
        .getStorage()
        .listAccounts(TELEGRAM_SERVICE_NAME);
      const persistedById = new Map(persisted.map((a) => [a.id, a]));

      const enabled = listEnabledTelegramAccounts(runtime);
      const synthesized: ConnectorAccount[] = enabled
        .filter((account) => !persistedById.has(account.accountId))
        .map((account) =>
          synthesizeAccount(account.accountId, account.name, undefined),
        );

      // If env-only single-account flow is configured but the resolved
      // accounts list is empty (e.g. token not yet validated), fall back to
      // surfacing a 'default' entry so downstream UIs always have an anchor.
      if (synthesized.length === 0 && persisted.length === 0) {
        const fallback = resolveTelegramAccount(runtime, DEFAULT_ACCOUNT_ID);
        if (fallback.botToken) {
          synthesized.push(
            synthesizeAccount(DEFAULT_ACCOUNT_ID, fallback.name, undefined),
          );
        }
      }

      return [...persisted, ...synthesized];
    },

    createAccount: async (input: ConnectorAccountPatch) => {
      // Manager owns persistence. Provide sensible defaults for Telegram bots:
      // role=AGENT (the bot is the agent identity) and purpose=messaging.
      return {
        ...input,
        provider: TELEGRAM_SERVICE_NAME,
        role: input.role ?? "AGENT",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "connected",
      };
    },

    patchAccount: async (_accountId: string, patch: ConnectorAccountPatch) => {
      return { ...patch, provider: TELEGRAM_SERVICE_NAME };
    },

    deleteAccount: async (): Promise<void> => {
      // Token cleanup is the runtime/secrets store's responsibility; the
      // manager removes the account row after this resolves.
    },

    // Telegram bots use a long-lived bot token; no OAuth flow exists.
    // startOAuth / completeOAuth are intentionally omitted.
  };
}
