import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceState = vi.hoisted(() => ({
  instances: [] as Array<{
    listRelationships: ReturnType<typeof vi.fn>;
    getHealthConnectorStatus: ReturnType<typeof vi.fn>;
    getHealthSummary: ReturnType<typeof vi.fn>;
    generateDossier: ReturnType<typeof vi.fn>;
  }>,
}));

const selfControlState = vi.hoisted(() => ({
  getSelfControlStatus: vi.fn(async () => ({
    available: true,
    active: true,
    endsAt: "2026-05-05T18:00:00.000Z",
    websites: ["x.com"],
    requiresElevation: false,
    engine: "native",
    platform: "darwin",
  })),
  startSelfControlBlock: vi.fn(),
  stopSelfControlBlock: vi.fn(),
  requestSelfControlPermission: vi.fn(),
}));

vi.mock("./lifeops-google-helpers.js", () => ({
  hasLifeOpsAccess: vi.fn(async () => true),
  runLifeOpsToonModel: vi.fn(async () => null),
}));

vi.mock("@elizaos/agent/security/access", () => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("./lifeops-grounded-reply.js", () => ({
  messageText: (message: Memory) =>
    typeof message.content?.text === "string" ? message.content.text : "",
  renderLifeOpsActionReply: vi.fn(
    async (args: { fallback: string }) => args.fallback,
  ),
}));

vi.mock("./life-recent-context.js", () => ({
  recentConversationTexts: vi.fn(async () => []),
}));

vi.mock("../lifeops/service.js", () => {
  class FakeLifeOpsService {
    listRelationships = vi.fn(async () => [
      {
        id: "rel-1",
        name: "Alice Chen",
        primaryChannel: "telegram",
        primaryHandle: "@alice",
        lastContactedAt: null,
        metadata: {},
      },
    ]);
    getHealthConnectorStatus = vi.fn(async () => ({
      available: true,
      backend: "healthkit",
    }));
    getHealthSummary = vi.fn(async () => ({
      providers: [],
      summaries: [],
      samples: [],
    }));
    generateDossier = vi.fn(async (input: { subject: string }) => ({
      id: "dos-1",
      subject: input.subject,
      contentMd: `Briefing for ${input.subject}`,
    }));

    constructor() {
      serviceState.instances.push(this);
    }
  }

  return { LifeOpsService: FakeLifeOpsService };
});

vi.mock("../website-blocker/access.ts", () => ({
  getSelfControlAccess: vi.fn(async () => ({ allowed: true })),
  SELFCONTROL_ACCESS_ERROR: "denied",
}));

vi.mock("../website-blocker/engine.ts", () => ({
  formatWebsiteList: (websites: readonly string[]) => websites.join(", "),
  getSelfControlStatus: selfControlState.getSelfControlStatus,
  getSelfControlPermissionState: vi.fn(),
  normalizeWebsiteTargets: (websites: readonly string[]) => [...websites],
  parseSelfControlBlockRequest: vi.fn(),
  requestSelfControlPermission: selfControlState.requestSelfControlPermission,
  startSelfControlBlock: selfControlState.startSelfControlBlock,
  stopSelfControlBlock: selfControlState.stopSelfControlBlock,
}));

vi.mock("../website-blocker/service.ts", () => ({
  syncWebsiteBlockerExpiryTask: vi.fn(async () => "task-1"),
}));

vi.mock("../website-blocker/chat-integration/harsh-mode-check.ts", () => ({
  hasActiveHarshNoBypassRule: vi.fn(async () => false),
}));

import { ownerAutofillAction } from "./owner-autofill.js";
import { dossierAction } from "./owner-dossier.js";
import { healthAction } from "./owner-health.js";
import { relationshipAction } from "./owner-relationship.js";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./owner-website-block.js";

const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000003" as UUID,
    roomId: ROOM_ID,
    entityId: ENTITY_ID,
    content: { text },
  } as Memory;
}

function makeRuntime(): IAgentRuntime & {
  getCache: ReturnType<typeof vi.fn>;
  setCache: ReturnType<typeof vi.fn>;
  useModel: ReturnType<typeof vi.fn>;
} {
  const cache = new Map<string, unknown>();
  return {
    agentId: "00000000-0000-0000-0000-000000000004" as UUID,
    character: { name: "Test Agent" },
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    useModel: vi.fn(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime & {
    getCache: ReturnType<typeof vi.fn>;
    setCache: ReturnType<typeof vi.fn>;
    useModel: ReturnType<typeof vi.fn>;
  };
}

describe("LifeOps router compression C", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceState.instances.length = 0;
  });

  it("collapses autofill legacy actions into one AUTOFILL router", async () => {
    expect(new Set([ownerAutofillAction.name])).toEqual(
      new Set(["OWNER_AUTOFILL"]),
    );

    const runtime = makeRuntime();
    const result = await ownerAutofillAction.handler?.(
      runtime,
      makeMessage("show autofill whitelist"),
      undefined,
      { parameters: { subaction: "whitelist_list" } },
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      actionName: "OWNER_AUTOFILL",
    });
    expect(result?.data).toHaveProperty("effective");
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("keeps autofill whitelist mutation behind the AUTOFILL subaction", async () => {
    const runtime = makeRuntime();
    const result = await ownerAutofillAction.handler?.(
      runtime,
      makeMessage("trust example.com for autofill"),
      undefined,
      {
        parameters: {
          subaction: "whitelist_add",
          domain: "https://login.example.com",
          confirmed: true,
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      actionName: "OWNER_AUTOFILL",
      domain: "example.com",
      added: true,
    });
  });

  it("keeps website blocker shims distinct from the owner router", async () => {
    expect(
      new Set([
        blockWebsitesAction.name,
        getWebsiteBlockStatusAction.name,
        requestWebsiteBlockingPermissionAction.name,
        unblockWebsitesAction.name,
      ]),
    ).toEqual(
      new Set([
        "BLOCK_WEBSITES",
        "GET_WEBSITE_BLOCK_STATUS",
        "REQUEST_WEBSITE_BLOCKING_PERMISSION",
        "UNBLOCK_WEBSITES",
      ]),
    );

    const result = await getWebsiteBlockStatusAction.handler?.(
      makeRuntime(),
      makeMessage("is a website block running"),
      undefined,
      {},
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      active: true,
      websites: ["x.com"],
    });
    expect(selfControlState.getSelfControlStatus).toHaveBeenCalled();
  });

  it("keeps relationship list/status under OWNER_RELATIONSHIP", async () => {
    const result = await relationshipAction.handler?.(
      makeRuntime(),
      makeMessage("show contacts"),
      undefined,
      { parameters: { subaction: "list_contacts" } },
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      subaction: "list_contacts",
      contacts: [expect.objectContaining({ name: "Alice Chen" })],
    });
  });

  it("keeps health status under HEALTH without an extractor call", async () => {
    const runtime = makeRuntime();
    const result = await healthAction.handler?.(
      runtime,
      makeMessage("is health connected"),
      undefined,
      { parameters: { subaction: "status" } },
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      subaction: "status",
      status: { available: true, backend: "healthkit" },
    });
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("keeps dossier generation as the state-changing DOSSIER action", async () => {
    const result = await dossierAction.handler?.(
      makeRuntime(),
      makeMessage("brief me on Alice"),
      undefined,
      { parameters: { subject: "Alice Chen" } },
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      actionName: "OWNER_DOSSIER",
      dossier: { id: "dos-1", subject: "Alice Chen" },
    });
  });
});
