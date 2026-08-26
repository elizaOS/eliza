/**
 * Drives the deterministic co-parent choreography through real Personal
 * Shared repositories, the real group route gate, the real webhook gateway,
 * a fake Blooio receipt boundary, and the real room-scoped memory store on
 * isolated PGlite. Model/runtime inference and the narrow direct-account lookup
 * adapter are deterministic substitutes; the consent repository still
 * revalidates mature, verified PGlite user rows.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import type { PlatformAdapter } from "../../services/gateway-webhook/src/adapters/types";
import type { GatewayRedis } from "../../services/gateway-webhook/src/redis";
import { pushSchema } from "../../shared/node_modules/drizzle-kit/api.mjs";
import { sql } from "../../shared/node_modules/drizzle-orm/index.js";
import {
  type BindingObservation,
  type ConsentSnapshot,
  type CoparentConsentScenarioPort,
  type JoinAttackObservation,
  type JoinAttackVector,
  runCoparentConsentScenario,
  type TurnObservation,
} from "./coparent-consent-scenario";
import {
  captureFromOutbox,
  isMessageSend,
  type OutboxEntry,
} from "./mock-blooio-provider";

const ENV_KEYS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "NODE_ENV",
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const ORGANIZATION_A = "91000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "91000000-0000-4000-8000-000000000002";
const USER_A = "91000000-0000-4000-8000-000000000011";
const USER_B = "91000000-0000-4000-8000-000000000012";
const PARENT_A_HANDLE = "+12025550101";
const PARENT_B_HANDLE = "+12025550102";
const CHILD_C_HANDLE = "+12025550103";
const ELIZA_HANDLE = "+12025550199";
const MAIN_GROUP_CHAT = "chat_coparent_consent";
const SINGLE_OWNER_CHAT = "chat_coparent_single_owner";
const PROJECT = "eliza-app";
const WEBHOOK_SECRET = "synthetic-coparent-webhook-secret";
const INTERNAL_SECRET = "synthetic-coparent-internal-secret";
const JOIN_CODE_SECRET = "synthetic-coparent-join-code-secret-v1";
const PRE_CONSENT_MEDIA_URL =
  "https://media.blooio.com/synthetic/parent-a-pre-consent.jpg";

let capabilityExecutions = 0;
let mainGroupConversationId = "";
const sharedRestMessageSend = mock(async (...args: unknown[]) => {
  capabilityExecutions += 1;
  const conversationId = String(args[1]);
  const rawParticipants =
    conversationId === mainGroupConversationId
      ? `${PARENT_A_HANDLE} and ${PARENT_B_HANDLE}`
      : PARENT_A_HANDLE;
  return {
    text: `Coordination capability completed for ${rawParticipants}.`,
  };
});
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const findActivePersonalDedicatedTarget = mock(async () => null);
const enrichInboundImageMedia = mock(async () => ({
  kind: "described" as const,
  description: "synthetic attachment description",
  reused: false,
}));
const resolvePersonalDelivery = mock(
  async (input: { platform: string; phoneNumber?: string }) => {
    if (input.platform !== "phone") {
      throw new Error("scenario requested an unknown synthetic direct account");
    }
    if (input.phoneNumber === PARENT_A_HANDLE) {
      return {
        userId: USER_A,
        organizationId: ORGANIZATION_A,
        dedicatedTarget: null,
        isNew: false,
        resolution: "single-query-repeat" as const,
      };
    }
    if (input.phoneNumber !== PARENT_B_HANDLE) {
      throw new Error("scenario requested an unknown synthetic direct account");
    }
    return {
      userId: USER_B,
      organizationId: ORGANIZATION_B,
      dedicatedTarget: null,
      isNew: false,
      resolution: "single-query-repeat" as const,
    };
  },
);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const executionWaitUntil = mock((_promise: Promise<unknown>) => undefined);

mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
  sharedTurnServerTiming: () => "",
}));
mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmPersonalSharedAgentTurnCaches,
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/eliza-app/inbound-media-enrichment", () => ({
  enrichInboundImageMedia,
}));
mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { resolvePersonalDelivery },
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: { waitUntil: executionWaitUntil },
  }),
}));

let closeDatabaseConnectionsForTests:
  | typeof import("../../shared/src/db/client").closeDatabaseConnectionsForTests
  | undefined;
let database: ReturnType<
  typeof import("../../shared/src/db/client").getPgliteClientForTests
>;
let groupsRepository: typeof import("../../shared/src/db/repositories/personal-shared-groups").personalSharedGroupsRepository;
let participantsRepository: typeof import("../../shared/src/db/repositories/personal-shared-group-participants").personalSharedGroupParticipantsRepository;
let consentRepository: typeof import("../../shared/src/db/repositories/personal-shared-group-consent").personalSharedGroupConsentRepository;
let routeApp: typeof import("../../api/internal/eliza-app/personal-shared/messages/route")["default"];
let handleWebhook: typeof import("../../services/gateway-webhook/src/webhook-handler").handleWebhook;
let blooioAdapter: PlatformAdapter;
let SharedMemoryStore: typeof import("../../shared/src/lib/services/shared-runtime/shared-memory-store").SharedMemoryStore;
let personalSharedAgent: typeof import("../../shared/src/lib/services/shared-runtime/personal-shared-agent").personalSharedAgent;

interface RouteResult {
  success: boolean;
  data?: {
    code?: string;
    reply?: string;
  };
  error?: string;
}

type RedisSetOptions = { ex?: number; nx?: boolean };

class MemoryRedis implements GatewayRedis {
  readonly store = new Map<string, string>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<unknown> {
    if (options.nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }

  async lpush(): Promise<unknown> {
    return 1;
  }

  async ltrim(): Promise<unknown> {
    return "OK";
  }

  async expire(): Promise<unknown> {
    return 1;
  }
}

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function futureExpiry(): Date {
  return new Date(Date.now() + 60_000);
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`scenario fixture missing ${label}`);
  return value;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function consentSnapshot(bindingId: string): Promise<ConsentSnapshot> {
  const status = requireValue(
    await consentRepository.deriveConsentStatus({ bindingId }),
    "consent status",
  );
  const { rows } = await database.query<{
    linked_user_id: string | null;
    consented_at: Date | null;
    consent_provenance: string | null;
  }>(
    `SELECT linked_user_id, consented_at, consent_provenance
       FROM personal_shared_group_participants
      WHERE binding_id = $1 AND revoked_at IS NULL AND linked_user_id IS NOT NULL
      ORDER BY ordinal`,
    [bindingId],
  );
  return {
    ...status,
    linkedPrincipalIds: rows.flatMap((row) =>
      row.linked_user_id ? [row.linked_user_id] : [],
    ),
    consentProvenances: rows.flatMap((row) =>
      row.consented_at && row.consent_provenance
        ? [row.consent_provenance]
        : [],
    ),
  };
}

async function routeRequest(
  requestBody: Record<string, unknown>,
): Promise<RouteResult> {
  const response = await routeApp.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
    {
      ELIZA_APP_PERSONAL_SHARED_ALL_ADULTS_ENABLED: "true",
      ELIZA_APP_PERSONAL_SHARED_JOIN_CODE_SECRET: JOIN_CODE_SECRET,
      INTERNAL_SECRET,
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      WHISPER_STT_URL: "https://whisper.invalid",
    } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
  const body = (await response.json()) as RouteResult;
  if (!response.ok) {
    throw new Error(
      `group route returned ${response.status}: ${body.error ?? "unknown error"}`,
    );
  }
  return body;
}

async function routeGroup(input: {
  chatId: string;
  actorHandle: string;
  message: string;
  messageId: string;
  invocation?: "mention" | "command" | "reply" | "ambient";
  mediaUrls?: string[];
}): Promise<RouteResult> {
  return routeRequest({
    platform: "blooio",
    chatType: "group",
    project: PROJECT,
    connectorAccountId: ELIZA_HANDLE,
    chatId: input.chatId,
    actor: {
      platformUserId: input.actorHandle,
      role: "possessor",
    },
    messageId: input.messageId,
    message: input.message,
    invocation: input.invocation ?? "mention",
    ...(input.mediaUrls ? { mediaUrls: input.mediaUrls } : {}),
  });
}

async function routeDirectBlooio(input: {
  actorHandle: string;
  message: string;
  messageId: string;
}): Promise<RouteResult> {
  return routeRequest({
    platform: "blooio",
    project: PROJECT,
    connectorAccountId: ELIZA_HANDLE,
    phoneNumber: input.actorHandle,
    messageId: input.messageId,
    message: input.message,
  });
}

function joinCodeFromRoute(result: RouteResult, expectedCode: string): string {
  expect(result.data?.code).toBe(expectedCode);
  const match = result.data?.reply?.match(
    /Eliza join ([2-9A-HJ-NP-Z]{8}(?:[2-9A-HJ-NP-Z]{4})?)(?=`|\s|$)/,
  );
  return requireValue(match?.[1], `${expectedCode} join code`);
}

function groupLinkCodeFromRoute(result: RouteResult): string {
  expect(result.data?.code).toBe("group_claim_issued");
  const match = result.data?.reply?.match(
    /Eliza link ([2-9A-HJ-NP-Z]{8})(?=`|\s|$)/,
  );
  return requireValue(match?.[1], "group claim link code");
}

async function bindingObservation(input: {
  chatId: string;
  codeLabel: string;
  mode?: "single_owner" | "all_adults";
}): Promise<BindingObservation> {
  if (input.mode === "all_adults") {
    const issued = await routeDirectBlooio({
      actorHandle: PARENT_A_HANDLE,
      message: "/group all-adults 2",
      messageId: `route-${input.codeLabel}-issue`,
    });
    const linkCode = groupLinkCodeFromRoute(issued);
    const bound = await routeGroup({
      chatId: input.chatId,
      actorHandle: PARENT_A_HANDLE,
      message: `Eliza link ${linkCode}`,
      messageId: `route-${input.codeLabel}-consume`,
      invocation: "command",
    });
    expect(bound.data?.code).toBe("group_bound");
    const stored = requireValue(
      await groupsRepository.resolveBinding({
        platform: "blooio",
        project: PROJECT,
        connectorAccountId: ELIZA_HANDLE,
        providerChatId: input.chatId,
      }),
      "route-created all-adults binding",
    );
    return {
      status: "bound",
      bindingId: stored.id,
      conversationId: stored.conversation_id,
      consent: await consentSnapshot(stored.id),
      routeStages: ["parent_a_dm_claim_issue", "group_claim_consume"],
    };
  }

  const agent = personalSharedAgent({
    userId: USER_A,
    organizationId: ORGANIZATION_A,
  });
  await groupsRepository.issueClaim({
    codeHash: hash(input.codeLabel),
    organizationId: ORGANIZATION_A,
    ownerUserId: USER_A,
    personalAgentId: agent.id,
    platform: "blooio",
    project: PROJECT,
    connectorAccountId: ELIZA_HANDLE,
    issuedToPlatformUserId: PARENT_A_HANDLE,
    expiresAt: futureExpiry(),
  });
  const consumed = await groupsRepository.consumeClaimAndBind({
    codeHash: hash(input.codeLabel),
    platform: "blooio",
    project: PROJECT,
    connectorAccountId: ELIZA_HANDLE,
    providerChatId: input.chatId,
    actorPlatformUserId: PARENT_A_HANDLE,
  });
  if (consumed.status !== "bound") {
    throw new Error(`owner claim did not bind: ${consumed.status}`);
  }
  return {
    status: "bound",
    bindingId: consumed.binding.id,
    conversationId: consumed.binding.conversation_id,
    consent: await consentSnapshot(consumed.binding.id),
  };
}

async function routeCapability(
  binding: BindingObservation,
  actorHandle: string,
  stage: string,
): Promise<TurnObservation> {
  const stored = requireValue(
    await groupsRepository.findBindingById(binding.bindingId),
    "group binding",
  );
  const before = capabilityExecutions;
  const enrichmentBefore = enrichInboundImageMedia.mock.calls.length;
  const prewarmBefore = prewarmPersonalSharedAgentTurnCaches.mock.calls.length;
  const mediaUrls = stage === "pre_consent" ? [PRE_CONSENT_MEDIA_URL] : [];
  const result = await routeGroup({
    chatId: stored.provider_chat_id,
    actorHandle,
    message: "Eliza, confirm the synthetic pickup plan",
    messageId: `route-${stage}`,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  });
  return {
    code: result.data?.code ?? "group_capability_reply",
    reply: result.data?.reply ?? "",
    roomId: stored.conversation_id,
    mediaUrlCount: mediaUrls.length,
    mediaEnrichmentExecuted:
      enrichInboundImageMedia.mock.calls.length > enrichmentBefore,
    runtimePrewarmExecuted:
      prewarmPersonalSharedAgentTurnCaches.mock.calls.length > prewarmBefore,
    capabilityExecuted: capabilityExecutions === before + 1,
  };
}

async function setupSchema(): Promise<void> {
  const client = await import("../../shared/src/db/client");
  closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
  database = client.getPgliteClientForTests();
  await client.dbWrite.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  const { organizations } = await import(
    "../../shared/src/db/schemas/organizations"
  );
  const { users } = await import("../../shared/src/db/schemas/users");
  const groupSchema = await import(
    "../../shared/src/db/schemas/personal-shared-groups"
  );
  const { sharedAgentMemories } = await import(
    "../../shared/src/db/schemas/shared-agent-memories"
  );
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      personalSharedGroupClaims: groupSchema.personalSharedGroupClaims,
      personalSharedGroupBindings: groupSchema.personalSharedGroupBindings,
      personalSharedGroupJoinChallenges:
        groupSchema.personalSharedGroupJoinChallenges,
      personalSharedGroupDeliveryReceipts:
        groupSchema.personalSharedGroupDeliveryReceipts,
      personalSharedGroupParticipants:
        groupSchema.personalSharedGroupParticipants,
      personalSharedGroupDeliveryAttempts:
        groupSchema.personalSharedGroupDeliveryAttempts,
      sharedAgentMemories,
    } as never,
    client.dbWrite as never,
  );
  await apply();
  await client.dbWrite.insert(organizations).values([
    {
      id: ORGANIZATION_A,
      name: "Synthetic Parent A",
      slug: "synthetic-parent-a",
    },
    {
      id: ORGANIZATION_B,
      name: "Synthetic Parent B",
      slug: "synthetic-parent-b",
    },
  ]);
  await client.dbWrite.insert(users).values([
    {
      id: USER_A,
      organization_id: ORGANIZATION_A,
      steward_user_id: "synthetic-mature-parent-a",
      name: "Parent A",
      phone_number: PARENT_A_HANDLE,
      phone_verified: true,
      is_anonymous: false,
      is_active: true,
    },
    {
      id: USER_B,
      organization_id: ORGANIZATION_B,
      steward_user_id: "synthetic-mature-parent-b",
      name: "Parent B",
      phone_number: PARENT_B_HANDLE,
      phone_verified: true,
      is_anonymous: false,
      is_active: true,
    },
  ]);
}

beforeAll(async () => {
  await setupSchema();
  ({ personalSharedGroupsRepository: groupsRepository } = await import(
    "../../shared/src/db/repositories/personal-shared-groups"
  ));
  ({ personalSharedGroupParticipantsRepository: participantsRepository } =
    await import(
      "../../shared/src/db/repositories/personal-shared-group-participants"
    ));
  ({ personalSharedGroupConsentRepository: consentRepository } = await import(
    "../../shared/src/db/repositories/personal-shared-group-consent"
  ));
  ({ SharedMemoryStore } = await import(
    "../../shared/src/lib/services/shared-runtime/shared-memory-store"
  ));
  ({ personalSharedAgent } = await import(
    "../../shared/src/lib/services/shared-runtime/personal-shared-agent"
  ));
  ({ default: routeApp } = await import(
    "../../api/internal/eliza-app/personal-shared/messages/route"
  ));
  ({ handleWebhook } = await import(
    "../../services/gateway-webhook/src/webhook-handler"
  ));
  ({ blooioAdapter } = await import(
    "../../services/gateway-webhook/src/adapters/blooio"
  ));
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restore();
});

describe("synthetic iMessage co-parent consent scenario", () => {
  test("returns a machine-readable ledger across consent, isolation, and delivery seams", async () => {
    let mainBinding: BindingObservation | undefined;
    let singleOwnerBinding: BindingObservation | undefined;
    let attackSequence = 0;

    const ensureSingleOwner = async (): Promise<BindingObservation> => {
      singleOwnerBinding ??= await bindingObservation({
        chatId: SINGLE_OWNER_CHAT,
        codeLabel: "single-owner-claim",
      });
      return singleOwnerBinding;
    };

    const issueAuthenticate = async (
      bindingId: string,
      label: string,
      providerThreadId: string | null = null,
    ) => {
      const stored = requireValue(
        await groupsRepository.findBindingById(bindingId),
        "challenge binding",
      );
      return consentRepository.issueJoinAuthenticateChallenge({
        codeHash: hash(`authenticate-${label}`),
        bindingId,
        platform: "blooio",
        project: PROJECT,
        connectorAccountId: ELIZA_HANDLE,
        providerChatId: stored.provider_chat_id,
        providerThreadId,
        actorPlatformUserId: PARENT_B_HANDLE,
        expiresAt: futureExpiry(),
      });
    };

    const authenticate = (
      label: string,
      actorPlatformUserId = PARENT_B_HANDLE,
    ) =>
      consentRepository.consumeJoinAuthenticateChallenge({
        codeHash: hash(`authenticate-${label}`),
        confirmCodeHash: hash(`confirm-${label}`),
        platform: "blooio",
        project: PROJECT,
        connectorAccountId: ELIZA_HANDLE,
        actorPlatformUserId,
        linkedUserId: USER_B,
        linkedOrganizationId: ORGANIZATION_B,
        expiresAt: futureExpiry(),
      });

    const routeJoinHandoff = async (bindingId: string, label: string) => {
      const stored = requireValue(
        await groupsRepository.findBindingById(bindingId),
        "route join binding",
      );
      const capabilityBefore = capabilityExecutions;
      const prewarmBefore =
        prewarmPersonalSharedAgentTurnCaches.mock.calls.length;
      const issued = await routeGroup({
        chatId: stored.provider_chat_id,
        actorHandle: PARENT_B_HANDLE,
        message: "Eliza join",
        messageId: `route-${label}-join-issue`,
        invocation: "command",
      });
      const authenticateCode = joinCodeFromRoute(
        issued,
        "group_join_authenticate_issued",
      );
      const authenticated = await routeDirectBlooio({
        actorHandle: PARENT_B_HANDLE,
        message: `Eliza join ${authenticateCode}`,
        messageId: `route-${label}-join-authenticate`,
      });
      const confirmCode = joinCodeFromRoute(
        authenticated,
        "group_join_confirm_issued",
      );
      expect(confirmCode).not.toBe(authenticateCode);
      // Simulate provider egress succeeding while its receipt response is
      // lost: reopening the exact source after DM authentication must display
      // the same code and must not erase the live confirmation handoff.
      const reopenedIssue = await routeGroup({
        chatId: stored.provider_chat_id,
        actorHandle: PARENT_B_HANDLE,
        message: "Eliza join",
        messageId: `route-${label}-join-issue`,
        invocation: "command",
      });
      expect(
        joinCodeFromRoute(reopenedIssue, "group_join_authenticate_issued"),
      ).toBe(authenticateCode);
      expect(capabilityExecutions).toBe(capabilityBefore);
      expect(prewarmPersonalSharedAgentTurnCaches.mock.calls.length).toBe(
        prewarmBefore,
      );
      return { stored, confirmCode };
    };

    const attackJoin = async (
      bindingId: string,
      vector: JoinAttackVector,
    ): Promise<JoinAttackObservation> => {
      attackSequence += 1;
      const label = `${attackSequence}-${vector}`;
      let status: string;
      let routeStages: string[] | undefined;
      let scopeRejectionSeam: "repository" | undefined;
      switch (vector) {
        case "forged": {
          status = (
            await consentRepository.consumeJoinAuthenticateChallenge({
              codeHash: hash(`never-issued-${label}`),
              confirmCodeHash: hash(`confirm-${label}`),
              platform: "blooio",
              project: PROJECT,
              connectorAccountId: ELIZA_HANDLE,
              actorPlatformUserId: PARENT_B_HANDLE,
              linkedUserId: USER_B,
              linkedOrganizationId: ORGANIZATION_B,
              expiresAt: futureExpiry(),
            })
          ).status;
          expect(status).toBe("invalid");
          break;
        }
        case "expired": {
          expect((await issueAuthenticate(bindingId, label)).status).toBe(
            "issued",
          );
          await database.query(
            `UPDATE personal_shared_group_join_challenges
                SET expires_at = now() - interval '1 second'
              WHERE code_hash = $1`,
            [hash(`authenticate-${label}`)],
          );
          status = (await authenticate(label)).status;
          expect(status).toBe("expired");
          break;
        }
        case "replayed": {
          expect((await issueAuthenticate(bindingId, label)).status).toBe(
            "issued",
          );
          expect((await authenticate(label)).status).toBe("confirm_issued");
          status = (await authenticate(label)).status;
          expect(status).toBe("already_used");
          break;
        }
        case "wrong_sender": {
          expect((await issueAuthenticate(bindingId, label)).status).toBe(
            "issued",
          );
          status = (await authenticate(label, CHILD_C_HANDLE)).status;
          expect(status).toBe("wrong_sender");
          break;
        }
        case "wrong_binding": {
          const other = await ensureSingleOwner();
          expect((await issueAuthenticate(bindingId, label)).status).toBe(
            "issued",
          );
          expect((await authenticate(label)).status).toBe("confirm_issued");
          const otherStored = requireValue(
            await groupsRepository.findBindingById(other.bindingId),
            "wrong-scope binding",
          );
          status = (
            await consentRepository.consumeJoinConfirmChallenge({
              codeHash: hash(`confirm-${label}`),
              bindingId: other.bindingId,
              platform: "blooio",
              project: PROJECT,
              connectorAccountId: ELIZA_HANDLE,
              providerChatId: otherStored.provider_chat_id,
              actorPlatformUserId: PARENT_B_HANDLE,
            })
          ).status;
          expect(status).toBe("wrong_scope");
          break;
        }
        case "cross_thread": {
          const { stored, confirmCode } = await routeJoinHandoff(
            bindingId,
            label,
          );
          status = (
            await consentRepository.consumeJoinConfirmChallenge({
              codeHash: hash(confirmCode),
              bindingId,
              platform: "blooio",
              project: PROJECT,
              connectorAccountId: ELIZA_HANDLE,
              providerChatId: stored.provider_chat_id,
              providerThreadId: "thread-other",
              actorPlatformUserId: PARENT_B_HANDLE,
            })
          ).status;
          expect(status).toBe("wrong_scope");
          routeStages = ["group_join_issue", "parent_b_dm_authenticate"];
          scopeRejectionSeam = "repository";
          break;
        }
      }
      return {
        vector,
        status,
        accepted: false,
        ...(routeStages ? { routeStages } : {}),
        ...(scopeRejectionSeam ? { scopeRejectionSeam } : {}),
      };
    };

    const port: CoparentConsentScenarioPort = {
      async bindAllAdults() {
        mainBinding = await bindingObservation({
          chatId: MAIN_GROUP_CHAT,
          codeLabel: "all-adults-owner-claim",
          mode: "all_adults",
        });
        mainGroupConversationId = mainBinding.conversationId;
        await participantsRepository.recordTurn({
          bindingId: mainBinding.bindingId,
          platformUserId: PARENT_B_HANDLE,
        });
        mainBinding.consent = await consentSnapshot(mainBinding.bindingId);
        return mainBinding;
      },

      readConsent(bindingId) {
        return consentSnapshot(bindingId);
      },

      async capabilityTurn(stage, bindingId) {
        const binding = requireValue(mainBinding, "main binding");
        expect(binding.bindingId).toBe(bindingId);
        return routeCapability(
          binding,
          stage === "post_consent" ? PARENT_B_HANDLE : PARENT_A_HANDLE,
          stage,
        );
      },

      attackJoin,

      async consentParentB(bindingId) {
        const label = "successful-parent-b";
        const { stored, confirmCode } = await routeJoinHandoff(
          bindingId,
          label,
        );
        const result = await routeGroup({
          chatId: stored.provider_chat_id,
          actorHandle: PARENT_B_HANDLE,
          message: `Eliza join ${confirmCode}`,
          messageId: `route-${label}-join-confirm`,
          invocation: "command",
        });
        expect(result.data?.code).toBe("group_join_consented");
        await participantsRepository.recordTurn({
          bindingId,
          platformUserId: CHILD_C_HANDLE,
        });
        return {
          status: "consented",
          consent: await consentSnapshot(bindingId),
          routeStages: [
            "group_join_issue",
            "parent_b_dm_authenticate",
            "group_join_confirm",
          ],
        };
      },

      async probeMemoryIsolation(binding) {
        const parentAAgent = personalSharedAgent({
          userId: USER_A,
          organizationId: ORGANIZATION_A,
        });
        const parentBAgent = personalSharedAgent({
          userId: USER_B,
          organizationId: ORGANIZATION_B,
        });
        const embed = {
          model: "synthetic-room-isolation",
          embedTexts: async (texts: string[]) => texts.map(() => [1, 0, 0]),
        };
        const groupStore = new SharedMemoryStore(
          {
            organizationId: ORGANIZATION_A,
            userId: USER_A,
            agentKey: parentAAgent.id,
            roomKey: binding.conversationId,
          },
          undefined,
          undefined,
          embed,
        );
        const parentAStore = new SharedMemoryStore(
          {
            organizationId: ORGANIZATION_A,
            userId: USER_A,
            agentKey: parentAAgent.id,
            roomKey: parentAAgent.id,
          },
          undefined,
          undefined,
          embed,
        );
        const parentBStore = new SharedMemoryStore(
          {
            organizationId: ORGANIZATION_B,
            userId: USER_B,
            agentKey: parentBAgent.id,
            roomKey: parentBAgent.id,
          },
          undefined,
          undefined,
          embed,
        );
        const groupMarker = "SHARED-HANDOFF-MARKER";
        const parentAMarker = "PARENT-A-PRIVATE-MARKER";
        const parentBMarker = "PARENT-B-PRIVATE-MARKER";
        await groupStore.recordTurnPair({
          userMessage: groupMarker,
          assistantReply: "shared response",
          messageIds: {
            user: "91000000-0000-4000-8000-000000000101",
            assistant: "91000000-0000-4000-8000-000000000102",
          },
        });
        await parentAStore.recordTurnPair({
          userMessage: parentAMarker,
          assistantReply: "private A response",
          messageIds: {
            user: "91000000-0000-4000-8000-000000000103",
            assistant: "91000000-0000-4000-8000-000000000104",
          },
        });
        await parentBStore.recordTurnPair({
          userMessage: parentBMarker,
          assistantReply: "private B response",
          messageIds: {
            user: "91000000-0000-4000-8000-000000000105",
            assistant: "91000000-0000-4000-8000-000000000106",
          },
        });
        const texts = (hits: Array<{ content: Record<string, unknown> }>) =>
          hits.flatMap((hit) =>
            typeof hit.content.text === "string" ? [hit.content.text] : [],
          );
        return {
          groupRoomId: binding.conversationId,
          parentADmRoomId: parentAAgent.id,
          parentBDmRoomId: parentBAgent.id,
          groupRecall: texts(await groupStore.searchByEmbedding([1, 0, 0], 10)),
          parentADmRecall: texts(
            await parentAStore.searchByEmbedding([1, 0, 0], 10),
          ),
          parentBDmRecall: texts(
            await parentBStore.searchByEmbedding([1, 0, 0], 10),
          ),
          expectedGroupMarker: groupMarker,
          expectedParentAMarker: parentAMarker,
          expectedParentBMarker: parentBMarker,
        };
      },

      async deliverExactlyOnce(binding) {
        process.env.ELIZA_APP_BLOOIO_API_KEY = "synthetic-api-key";
        process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = ELIZA_HANDLE;
        process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET = WEBHOOK_SECRET;
        const originalFetch = globalThis.fetch;
        const outbox: OutboxEntry[] = [];
        const receiptIds: string[] = [];
        let providerSendCount = 0;
        let routeExecutions = 0;
        const capabilityBefore = capabilityExecutions;

        globalThis.fetch = mock(async (input, init) => {
          const request = new Request(input, init);
          if (
            request.url.endsWith(
              "/api/internal/eliza-app/personal-shared/messages",
            )
          ) {
            const rawBody = await request.text();
            const parsed = JSON.parse(rawBody) as { eventType?: string };
            if (!parsed.eventType) routeExecutions += 1;
            return routeApp.request(
              "/",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${INTERNAL_SECRET}`,
                  "content-type": "application/json",
                },
                body: rawBody,
              },
              {
                INTERNAL_SECRET,
                ELIZA_APP_PERSONAL_SHARED_JOIN_CODE_SECRET: JOIN_CODE_SECRET,
                SHARED_RUNTIME_CONVERSATIONS: namespace,
                WHISPER_STT_URL: "https://whisper.invalid",
              } as never,
              {
                waitUntil() {},
                passThroughOnException() {},
                props: {},
              } as never,
            );
          }
          if (request.url.endsWith("/api/internal/identity/resolve")) {
            return Response.json({ success: false }, { status: 404 });
          }
          const url = new URL(request.url);
          if (url.hostname === "api.blooio.com") {
            const body = await request.text();
            outbox.push({
              n: outbox.length + 1,
              at: "synthetic-sequence",
              method: request.method,
              path: url.pathname,
              headers: {
                authorization: request.headers.has("authorization")
                  ? "[REDACTED]"
                  : null,
                "idempotency-key": request.headers.has("idempotency-key")
                  ? "[REDACTED]"
                  : null,
                "x-from-number": request.headers.get("x-from-number"),
              },
              body: body || null,
            });
            if (isMessageSend(request.method, url.pathname)) {
              providerSendCount += 1;
              const id = `synthetic-provider-receipt-${providerSendCount}`;
              receiptIds.push(id);
              return Response.json({ id });
            }
            return Response.json({ ok: true });
          }
          throw new Error(`unexpected scenario fetch: ${request.url}`);
        }) as unknown as typeof fetch;

        try {
          const rawBody = JSON.stringify({
            id: "evt-coparent-exactly-once",
            type: "message.received",
            created_at: Date.now(),
            data: {
              id: "msg-coparent-exactly-once",
              message_id: "msg-coparent-exactly-once",
              chat_id: MAIN_GROUP_CHAT,
              channel_id: "synthetic-blooio-channel",
              channel_type: "blooio",
              direction: "inbound",
              sender: PARENT_B_HANDLE,
              recipient: ELIZA_HANDLE,
              channel_address: ELIZA_HANDLE,
              text: "Eliza, confirm the synthetic pickup plan",
              protocol: "imessage",
              is_group: true,
              group: { name: "Synthetic co-parenting" },
              attachments: [],
            },
          });
          const timestamp = Math.floor(Date.now() / 1_000);
          const signature = createHmac("sha256", WEBHOOK_SECRET)
            .update(`${timestamp}.${rawBody}`)
            .digest("hex");
          const request = () =>
            new Request("https://gateway.invalid/webhook/eliza-app/blooio", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-blooio-signature": `t=${timestamp},v1=${signature}`,
              },
              body: rawBody,
            });
          const redis = new MemoryRedis();
          const dependencies = {
            redis,
            cloudBaseUrl: "https://cloud.invalid",
            getAuthHeader: () => ({
              Authorization: `Bearer ${INTERNAL_SECRET}`,
            }),
          };
          expect(
            (
              await handleWebhook(
                request(),
                blooioAdapter,
                dependencies,
                PROJECT,
              )
            ).status,
          ).toBe(200);
          await waitFor(
            async () =>
              receiptIds.length === 1 &&
              (await groupsRepository.hasDeliveryReceipt({
                bindingId: binding.bindingId,
                providerMessageId: receiptIds[0] ?? "",
              })),
            "provider receipt persistence",
          );
          expect(
            (
              await handleWebhook(
                request(),
                blooioAdapter,
                dependencies,
                PROJECT,
              )
            ).status,
          ).toBe(200);
          await Bun.sleep(50);
          const captured = captureFromOutbox(
            outbox.map((entry) => JSON.stringify(entry)).join("\n"),
          );
          return {
            inboundAttempts: 2,
            routeExecutions,
            providerSends: providerSendCount,
            providerReceiptIds: [...receiptIds],
            authoritativeReceiptRecorded:
              await groupsRepository.hasDeliveryReceipt({
                bindingId: binding.bindingId,
                providerMessageId: receiptIds[0] ?? "",
              }),
            replies: captured.map((entry) => entry.text),
          };
        } finally {
          globalThis.fetch = originalFetch;
          expect(capabilityExecutions - capabilityBefore).toBe(1);
        }
      },

      async selfLeaveParentB(bindingId) {
        const stored = requireValue(
          await groupsRepository.findBindingById(bindingId),
          "self-leave binding",
        );
        const response = await routeGroup({
          chatId: stored.provider_chat_id,
          actorHandle: PARENT_B_HANDLE,
          message: "Eliza leave",
          messageId: "route-parent-b-self-leave",
          invocation: "command",
        });
        const consent = await consentSnapshot(bindingId);
        return {
          status: response.data?.code ?? "unknown",
          ownerStillConsented: consent.participants.some(
            (participant) =>
              participant.isOwner &&
              participant.consented &&
              !participant.revoked,
          ),
          parentBRevoked: consent.participants.some(
            (participant) => !participant.isOwner && participant.revoked,
          ),
          consent,
          reply: response.data?.reply ?? "",
        };
      },

      async bindSingleOwner() {
        const binding = await ensureSingleOwner();
        return {
          binding,
          turn: await routeCapability(
            binding,
            PARENT_A_HANDLE,
            "single-owner-regression",
          ),
        };
      },
    };

    const ledger = await runCoparentConsentScenario(port, [
      PARENT_A_HANDLE,
      PARENT_B_HANDLE,
      CHILD_C_HANDLE,
      ELIZA_HANDLE,
    ]);
    expect(ledger.verdict).toBe("PASS");
    expect(Object.values(ledger.assertions).every(({ pass }) => pass)).toBe(
      true,
    );
    const serialized = JSON.stringify(ledger);
    for (const handle of [
      PARENT_A_HANDLE,
      PARENT_B_HANDLE,
      CHILD_C_HANDLE,
      ELIZA_HANDLE,
    ]) {
      expect(serialized).not.toContain(handle);
    }
    process.stdout.write(
      `${JSON.stringify({ kind: "coparent-consent-ledger", ledger })}\n`,
    );
  }, 60_000);
});
