/**
 * Proves the launch-critical personal Eliza path against the real local Worker,
 * PGlite database, and Durable Objects. External model credentials are blanked:
 * the first turn is a deterministic Shared capability refusal, so any accidental
 * provider dispatch changes the response or fails instead of spending money.
 */

import { randomUUID } from "node:crypto";
import { mintStewardTokenFromClaims } from "@elizaos/cloud-shared/lib/auth/steward-client";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
// The coverage classifier requires a direct Playwright marker for changed specs.
import type {} from "@playwright/test";
import { retrySharedRuntimeWarming } from "../src/helpers/shared-runtime";
import { expect, test } from "../src/helpers/test-fixtures";

const STEWARD_JWT_SECRET = "personal-eliza-first-five-local-secret-32-bytes";
const STEWARD_USER_ID = "steward-personal-eliza-first-five";
const RUN_ID = randomUUID();
const TELEGRAM_USER_ID = BigInt(
  `0x${RUN_ID.replaceAll("-", "").slice(0, 15)}`,
).toString();
const CAPABILITY_REQUEST = "save this as a note";
const CAPABILITY_REPLY =
  "Persistent notes need Dedicated. I can remember this conversation, but Shared doesn't manage a separate notes store.";

test.use({
  stackOptions: {
    frontend: false,
    env: {
      STEWARD_JWT_SECRET,
      STEWARD_TENANT_ID: "elizacloud",
      // The sync script normally preserves real provider keys from a developer's
      // shell/.env. An explicit empty override keeps this proof offline and free.
      PRESERVE_E2E_PROVIDER_ENV: "1",
      CEREBRAS_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      ANTHROPIC_API_KEY: "",
      GROQ_API_KEY: "",
    },
  },
});

interface SharedDeliveryResponse {
  success?: boolean;
  data?: {
    identity?: { id?: string; runtime?: string };
    account?: { userId?: string; organizationId?: string };
    reply?: string;
  };
  code?: string;
  retryable?: boolean;
}

interface SharedHistoryResponse {
  messages?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  code?: string;
  retryable?: boolean;
}

async function readJson<T>(
  response: Response,
): Promise<{ status: number; json: T }> {
  return {
    status: response.status,
    json: (await response.json()) as T,
  };
}

async function postTelegramDelivery(
  apiBase: string,
  input: { messageId: string; message: string },
): Promise<{ status: number; json: SharedDeliveryResponse }> {
  return await readJson<SharedDeliveryResponse>(
    await fetch(`${apiBase}/api/internal/eliza-app/personal-shared/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-internal-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: "telegram",
        project: "eliza-app",
        chatId: TELEGRAM_USER_ID,
        telegramUserId: TELEGRAM_USER_ID,
        telegramUsername: "first_five_nubs",
        displayName: "Nubs",
        ...input,
      }),
    }),
  );
}

function continuationTokenFromReply(reply: string): string {
  const urlStart = reply.indexOf("http");
  if (urlStart < 0)
    throw new Error("Telegram /connect reply did not include a URL");
  const token = new URL(reply.slice(urlStart)).searchParams.get(
    "onboardingSession",
  );
  if (!token)
    throw new Error("Telegram /connect URL did not include onboardingSession");
  return token;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function waitForMirroredHistory(agentId: string): Promise<{
  channelIds: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
}> {
  const { sharedRuntimeHistoryRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/shared-runtime-history"
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const channelIds =
      await sharedRuntimeHistoryRepository.listChannelsByAgent(agentId);
    const channelId = channelIds[0];
    const history = channelId
      ? await sharedRuntimeHistoryRepository.get(agentId, channelId)
      : [];
    const visibleHistory = history.filter(
      (entry): entry is typeof entry & { role: "user" | "assistant" } =>
        entry.role !== "system",
    );
    if (channelIds.length === 1 && visibleHistory.length === 2) {
      return { channelIds, history: visibleHistory };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const channelIds =
    await sharedRuntimeHistoryRepository.listChannelsByAgent(agentId);
  const channelId = channelIds[0];
  return {
    channelIds,
    history: channelId
      ? (await sharedRuntimeHistoryRepository.get(agentId, channelId)).filter(
          (entry): entry is typeof entry & { role: "user" | "assistant" } =>
            entry.role !== "system",
        )
      : [],
  };
}

test.describe("personal Eliza first five minutes", () => {
  test("keeps first contact rowless and free, replays it, then claims the same account and history", async ({
    stack,
  }) => {
    test.setTimeout(180_000);

    // Both initial webhook deliveries race before the Telegram account exists.
    // The DB convergence and Durable Object claim ledger must still produce one
    // account and one landed turn rather than duplicate users or model work.
    const firstDeliveries = await Promise.all(
      [0, 1].map(() =>
        retrySharedRuntimeWarming(() =>
          postTelegramDelivery(stack.urls.api, {
            messageId: `telegram:first-five:${RUN_ID}:1`,
            message: CAPABILITY_REQUEST,
          }),
        ),
      ),
    );
    for (const delivery of firstDeliveries) {
      expect(
        delivery.status,
        `first delivery failed: ${JSON.stringify(delivery.json)}`,
      ).toBe(200);
      expect(delivery.json.data?.reply).toBe(CAPABILITY_REPLY);
    }

    const account = firstDeliveries[0]?.json.data?.account;
    const personalId = firstDeliveries[0]?.json.data?.identity?.id;
    expect(account?.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(account?.organizationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(personalId).toMatch(/^personal:/);
    if (!account?.userId || !account.organizationId || !personalId) {
      throw new Error(
        "first contact did not return the canonical account identity",
      );
    }
    expect(personalId).toBe(
      personalSharedAgentId({
        userId: account.userId,
        organizationId: account.organizationId,
      }),
    );
    expect(firstDeliveries[1]?.json.data?.account).toEqual(account);
    expect(firstDeliveries[1]?.json.data?.identity?.id).toBe(personalId);

    const { usersRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/users"
    );
    const { organizationsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/organizations"
    );
    const { apiKeysService } = await import(
      "@elizaos/cloud-shared/lib/services/api-keys"
    );
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    const { containersRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/containers"
    );
    const { jobsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/jobs"
    );
    const { creditTransactionsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/credit-transactions"
    );

    const provisional =
      await usersRepository.findByTelegramIdWithOrganization(TELEGRAM_USER_ID);
    expect(provisional?.id).toBe(account.userId);
    expect(provisional?.organization_id).toBe(account.organizationId);
    expect(
      await usersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(1);
    expect(
      (await organizationsRepository.findById(account.organizationId))
        ?.credit_balance,
    ).toBe("0.000000");
    expect(
      await apiKeysService.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await agentSandboxesRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await containersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await jobsRepository.findByFilters({
        organizationId: account.organizationId,
      }),
    ).toHaveLength(0);
    expect(
      await creditTransactionsRepository.listByOrganization(
        account.organizationId,
      ),
    ).toHaveLength(0);

    const mirrored = await waitForMirroredHistory(personalId);
    expect(mirrored.channelIds).toHaveLength(1);
    expect(
      mirrored.history.map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: "user", content: CAPABILITY_REQUEST },
      { role: "assistant", content: CAPABILITY_REPLY },
    ]);

    // /connect creates a separate opaque, account-bound continuation in the
    // real onboarding Durable Object without entering chat or provisioning.
    const connect = await postTelegramDelivery(stack.urls.api, {
      messageId: `telegram:first-five:${RUN_ID}:connect`,
      message: "/connect",
    });
    expect(connect.status, JSON.stringify(connect.json)).toBe(200);
    expect(connect.json.data?.account).toEqual(account);
    expect(connect.json.data?.identity?.id).toBe(personalId);
    const reply = connect.json.data?.reply;
    if (!reply) throw new Error("Telegram /connect did not return a reply");
    const continuationToken = continuationTokenFromReply(reply);

    const now = Math.floor(Date.now() / 1000);
    const minted = await mintStewardTokenFromClaims(
      { STEWARD_JWT_SECRET },
      {
        userId: STEWARD_USER_ID,
        email: "nubs-first-five@e2e.test",
        tenantId: "elizacloud",
        issuedAt: now,
        expiration: now + 900,
      },
      900,
    );
    if (!minted) throw new Error("local Steward token mint was not configured");

    const claimResponse = await fetch(
      `${stack.urls.api}/api/auth/steward-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: stack.urls.api,
        },
        body: JSON.stringify({
          token: minted.token,
          telegramContinuation: continuationToken,
        }),
      },
    );
    const claimBody = (await claimResponse.clone().json()) as {
      ok?: boolean;
      userId?: string;
      stewardUserId?: string;
    };
    expect(
      claimResponse.status,
      `Steward claim failed: ${JSON.stringify(claimBody)}`,
    ).toBe(200);
    expect(claimBody).toMatchObject({
      ok: true,
      userId: account.userId,
      stewardUserId: STEWARD_USER_ID,
    });

    const claimed =
      await usersRepository.findByStewardIdWithOrganization(STEWARD_USER_ID);
    expect(claimed?.id).toBe(account.userId);
    expect(claimed?.organization_id).toBe(account.organizationId);
    expect(claimed?.telegram_id).toBe(TELEGRAM_USER_ID);
    expect(
      await usersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(1);

    const cookie = cookieHeader(claimResponse);
    expect(cookie).toContain("steward-token-local=");
    const personalResponse = await fetch(
      `${stack.urls.api}/api/v1/eliza/personal`,
      {
        headers: { Cookie: cookie },
      },
    );
    const personalBody = (await personalResponse.json()) as {
      data?: { identity?: { id?: string; runtime?: string } };
    };
    expect(personalResponse.status, JSON.stringify(personalBody)).toBe(200);
    expect(personalBody.data?.identity).toMatchObject({
      id: personalId,
      runtime: "shared",
    });

    const historyPath = `/api/v1/eliza/agents/${encodeURIComponent(
      personalId,
    )}/api/conversations/${encodeURIComponent(personalId)}/messages`;
    const authenticatedHistory = await retrySharedRuntimeWarming(async () =>
      readJson<SharedHistoryResponse>(
        await fetch(`${stack.urls.api}${historyPath}`, {
          headers: { Cookie: cookie },
        }),
      ),
    );
    expect(
      authenticatedHistory.status,
      `authenticated history failed: ${JSON.stringify(authenticatedHistory.json)}`,
    ).toBe(200);
    expect(
      authenticatedHistory.json.messages?.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: CAPABILITY_REQUEST },
      { role: "assistant", text: CAPABILITY_REPLY },
    ]);

    // Account claim and authenticated reads must not silently mint spendable
    // balance, an API credential, or any compute/provisioning artifact.
    expect(
      (await organizationsRepository.findById(account.organizationId))
        ?.credit_balance,
    ).toBe("0.000000");
    expect(
      await apiKeysService.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await agentSandboxesRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await containersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await jobsRepository.findByFilters({
        organizationId: account.organizationId,
      }),
    ).toHaveLength(0);
    expect(
      await creditTransactionsRepository.listByOrganization(
        account.organizationId,
      ),
    ).toHaveLength(0);
  });
});
