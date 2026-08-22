/**
 * Keyless, model-free coverage for progressive reads across the production
 * FILE, DOCUMENT, ATTACHMENT, and MESSAGE action surfaces. Seeds large source
 * objects through real services, then proves exact continuation metadata and
 * single-carrier page text without putting planted canaries in turn prompts.
 */

import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory, ReadView, UUID } from "@elizaos/core";
import { getDefaultTriageService, stringToUuid } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import codingToolsPlugin from "../../../../plugins/plugin-coding-tools/src/index.ts";
import { GoogleGmailAdapter } from "../../../../plugins/plugin-google-workspace/src/lifeops-message-adapter.ts";
import {
  DocumentService,
  documentsPlugin,
} from "../../../core/src/features/documents/index.ts";

const SCENARIO_ID = "deterministic-progressive-content-actions";
let fixtureRoot = "";
let filePath = "";

const FILE_CANARY = "FILE-LATE-CANARY-7f32";
const DOCUMENT_CANARY = "DOCUMENT-LATE-CANARY-8a41";
const ATTACHMENT_CANARY = "ATTACHMENT-LATE-CANARY-9b50";
const MEMORY_CANARY = "MEMORY-LATE-CANARY-ac61";
const LARGE_PREFIX = "x".repeat(1024 * 1024);
const FILE_SOURCE = `${LARGE_PREFIX}${FILE_CANARY}`;
const ATTACHMENT_SOURCE = `${LARGE_PREFIX}${ATTACHMENT_CANARY}`;
const MEMORY_SOURCE = `${LARGE_PREFIX}${MEMORY_CANARY}`;
const DOCUMENT_LINES = [
  ...Array.from({ length: 200 }, (_, index) => `document-line-${index}\n`),
  `${DOCUMENT_CANARY}\n`,
];
const DOCUMENT_SOURCE = DOCUMENT_LINES.join("");
const GMAIL_BODY =
  "Hi there,\n\nWe received invoice 4831 for April. Please confirm receipt when you get a chance.\n\nThanks,\nFinance Team";

let documentId = stringToUuid(`${SCENARIO_ID}:document`) as UUID;
const ATTACHMENT_MEMORY_ID = stringToUuid(
  `${SCENARIO_ID}:attachment-memory`,
) as UUID;
const MESSAGE_MEMORY_ID = stringToUuid(`${SCENARIO_ID}:message-memory`) as UUID;
const RESTRICTED_MEMORY_ID = stringToUuid(
  `${SCENARIO_ID}:restricted-memory`,
) as UUID;
const RESTRICTED_ROOM_ID = stringToUuid(
  `scenario-room:${SCENARIO_ID}:restricted`,
) as UUID;

type JsonRecord = Record<string, unknown>;
type ScenarioRuntime = IAgentRuntime & {
  plugins?: Array<{ name?: string }>;
  registerPlugin: (plugin: unknown) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionFor(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  return (
    execution.actionsCalled.find(
      (action) => action.actionName === actionName,
    ) ??
    `expected ${actionName}; saw ${execution.actionsCalled.map((action) => action.actionName).join(", ") || "none"}`
  );
}

function resultData(action: CapturedAction): JsonRecord | string {
  return isRecord(action.result?.data)
    ? action.result.data
    : `expected ActionResult.data, saw ${JSON.stringify(action.result?.data)}`;
}

function readViewFrom(action: CapturedAction): ReadView | string {
  const data = resultData(action);
  if (typeof data === "string") return data;
  const candidate = data.readView;
  if (
    !isRecord(candidate) ||
    !isRecord(candidate.reference) ||
    !isRecord(candidate.slice)
  ) {
    return `expected readView, saw ${JSON.stringify(candidate)}`;
  }
  return candidate as unknown as ReadView;
}

function exactPageFailure(
  action: CapturedAction,
  expectedText: string,
  expectedRange: { unit: string; start: number; end: number; total: number },
): string | undefined {
  if (action.result?.success !== true) {
    return `expected success, saw ${JSON.stringify(action.result)}`;
  }
  if (action.result.text !== expectedText) {
    return `expected exact page ${JSON.stringify(expectedText)}, saw ${JSON.stringify(action.result.text)}`;
  }
  const view = readViewFrom(action);
  if (typeof view === "string") return view;
  if (JSON.stringify(view.slice.range) !== JSON.stringify(expectedRange)) {
    return `expected range ${JSON.stringify(expectedRange)}, saw ${JSON.stringify(view.slice.range)}`;
  }
  const pageMarker = expectedText.slice(-32);
  const dataJson = JSON.stringify(action.result.data) ?? "";
  const promptDataJson = JSON.stringify(action.result.promptData) ?? "";
  if (
    pageMarker &&
    (dataJson.includes(pageMarker) || promptDataJson.includes(pageMarker))
  ) {
    return "exact page text was duplicated into data or promptData";
  }
  return undefined;
}

const fileFirst = {
  action: "read",
  file_path: filePath,
  unit: "byte",
  offset: 0,
  limit: 4096,
};
const fileLate: JsonRecord = {
  action: "read",
  file_path: filePath,
  unit: "byte",
  offset: Buffer.byteLength(FILE_SOURCE) - Buffer.byteLength(FILE_CANARY),
  limit: 128,
};
const documentFirst = {
  action: "read",
  documentId,
  unit: "line",
  offset: 0,
  limit: 10,
};
const documentLate: JsonRecord = {
  action: "read",
  documentId,
  unit: "line",
  offset: 200,
  limit: 1,
};
const attachmentFirst = {
  action: "read",
  attachmentId: "progressive-attachment",
  offset: 0,
  limit: 4096,
};
const attachmentLate: JsonRecord = {
  action: "read",
  attachmentId: "progressive-attachment",
  offset:
    Buffer.byteLength(ATTACHMENT_SOURCE) - Buffer.byteLength(ATTACHMENT_CANARY),
  limit: 128,
};
const memoryFirst = {
  action: "read_channel",
  messageId: MESSAGE_MEMORY_ID,
  offset: 0,
  limit: 4096,
};
const memoryLate: JsonRecord = {
  action: "read_channel",
  offset: Buffer.byteLength(MEMORY_SOURCE) - Buffer.byteLength(MEMORY_CANARY),
  limit: 128,
};
const gmailFirst = {
  action: "read_message",
  source: "gmail",
  accountId: "default",
  messageId: "msg-finance",
  unit: "byte",
  offset: 0,
  limit: 16,
};
const gmailNext: JsonRecord = {
  action: "read_message",
  source: "gmail",
  unit: "byte",
  offset: 16,
  limit: 65_536,
};
const fileMutate = {
  action: "write",
  file_path: filePath,
  content: "replacement after continuation",
};
const fileStale: JsonRecord = {
  action: "read",
  file_path: filePath,
  unit: "byte",
  offset: 4096,
  limit: 128,
};
const restrictedMemoryRead = {
  action: "read_channel",
  messageId: RESTRICTED_MEMORY_ID,
  offset: 0,
  limit: 128,
};
const MESSAGE_ROUTING = {
  metadata: { __responseContext: { primaryContext: "messaging" } },
};

function captureContinuation(
  action: CapturedAction,
  target: JsonRecord,
  includeReference = false,
): string | undefined {
  const view = readViewFrom(action);
  if (typeof view === "string") return view;
  if (!view.slice.revision) return "first page omitted revision";
  target.expectedRevision = view.slice.revision;
  if (includeReference && view.reference.ref) {
    target.reference = view.reference.ref;
  }
  return undefined;
}

async function setupSources(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as ScenarioRuntime;
  if (!ctx.primaryRoomId || !ctx.primaryUserId) {
    return "scenario primary room/user unavailable";
  }
  const { seedGoogleConnectorGrant } = await import(
    "../../../../plugins/plugin-personal-assistant/test/support/helpers/seed-grants.ts"
  );
  await seedGoogleConnectorGrant(
    runtime as unknown as Parameters<typeof seedGoogleConnectorGrant>[0],
    {
      capabilities: ["google.gmail.triage"],
      email: "owner@example.test",
      grantId: "progressive-content-read",
    },
  );
  getDefaultTriageService().register(new GoogleGmailAdapter());
  const runDir = process.env.ELIZA_LIFEOPS_RUN_DIR?.trim();
  if (runDir) {
    fixtureRoot = path.join(
      path.resolve(runDir),
      "fixtures",
      `${SCENARIO_ID}-${process.pid}`,
    );
    await fs.mkdir(fixtureRoot, { recursive: true });
  } else {
    fixtureRoot = await fs.mkdtemp(
      path.join(realpathSync(os.tmpdir()), `${SCENARIO_ID}-`),
    );
  }
  filePath = path.join(fixtureRoot, "late-evidence.txt");
  fileFirst.file_path = filePath;
  fileLate.file_path = filePath;
  fileMutate.file_path = filePath;
  fileStale.file_path = filePath;
  await fs.writeFile(filePath, FILE_SOURCE, "utf8");
  process.env.CODING_TOOLS_WORKSPACE_ROOTS = fixtureRoot;

  if (
    !runtime.plugins?.some(
      (plugin) =>
        plugin.name === "coding-tools" ||
        plugin.name === "@elizaos/plugin-coding-tools",
    )
  ) {
    await runtime.registerPlugin(codingToolsPlugin);
  }
  await Promise.all([
    runtime.getServiceLoadPromise?.("CODING_TOOLS_SESSION_CWD"),
    runtime.getServiceLoadPromise?.("CODING_TOOLS_SANDBOX"),
  ]);
  const session = runtime.getService("CODING_TOOLS_SESSION_CWD") as {
    setCwd?: (conversationId: string, absPath: string) => void;
  } | null;
  const sandbox = runtime.getService("CODING_TOOLS_SANDBOX") as {
    addRoot?: (conversationId: string, absPath: string) => void;
  } | null;
  if (!session?.setCwd || !sandbox?.addRoot) {
    return "coding-tools workspace services unavailable";
  }
  sandbox.addRoot(ctx.primaryRoomId, fixtureRoot);
  session.setCwd(ctx.primaryRoomId, fixtureRoot);

  if (
    !runtime.plugins?.some((plugin) => plugin.name === documentsPlugin.name)
  ) {
    await runtime.registerPlugin(documentsPlugin);
  }
  await runtime.getServiceLoadPromise?.(DocumentService.serviceType);
  const documentService = runtime.getService<DocumentService>(
    DocumentService.serviceType,
  );
  if (!documentService) return "document service unavailable";
  const room = await runtime.getRoom(ctx.primaryRoomId as UUID);
  if (!room?.worldId) return "scenario room world unavailable";
  const storedDocument = await documentService.addDocument({
    worldId: room.worldId,
    roomId: ctx.primaryRoomId as UUID,
    entityId: ctx.primaryUserId as UUID,
    clientDocumentId: documentId,
    contentType: "text/markdown",
    originalFilename: "progressive-document.md",
    content: DOCUMENT_SOURCE,
    scope: "global",
    addedBy: ctx.primaryUserId as UUID,
    addedByRole: "OWNER",
    addedFrom: "import",
    metadata: { title: "Progressive scenario document" },
  });
  documentId = storedDocument.clientDocumentId as UUID;
  documentFirst.documentId = documentId;
  documentLate.documentId = documentId;

  await runtime.createMemory(
    {
      id: ATTACHMENT_MEMORY_ID,
      agentId: runtime.agentId,
      entityId: ctx.primaryUserId as UUID,
      roomId: ctx.primaryRoomId as UUID,
      content: {
        text: "Attachment fixture envelope without its planted answer.",
        source: "client_chat",
        attachments: [
          {
            id: "progressive-attachment",
            url: "https://example.invalid/progressive-attachment.txt",
            title: "progressive-attachment.txt",
            contentType: "document",
            mimeType: "text/plain",
            text: ATTACHMENT_SOURCE,
          },
        ],
      },
      metadata: { type: "message", scope: "global" },
      createdAt: Date.now() - 1,
    } as Memory,
    "messages",
  );
  await runtime.createMemory(
    {
      id: MESSAGE_MEMORY_ID,
      agentId: runtime.agentId,
      entityId: ctx.primaryUserId as UUID,
      roomId: ctx.primaryRoomId as UUID,
      content: { text: MEMORY_SOURCE, source: "client_chat" },
      metadata: { type: "message", scope: "room" },
      createdAt: Date.now(),
    } as Memory,
    "messages",
  );
  await runtime.createMemory(
    {
      id: RESTRICTED_MEMORY_ID,
      agentId: runtime.agentId,
      entityId: stringToUuid(
        `scenario-account:${SCENARIO_ID}:restricted`,
      ) as UUID,
      roomId: RESTRICTED_ROOM_ID,
      content: { text: "restricted room content", source: "client_chat" },
      metadata: { type: "message", scope: "room" },
      createdAt: Date.now(),
    } as Memory,
    "messages",
  );
  return undefined;
}

function finalLedger(ctx: ScenarioContext): string | undefined {
  const actions = ctx.actionsCalled ?? [];
  const expected = [
    "FILE",
    "FILE",
    "FILE",
    "FILE",
    "DOCUMENT",
    "DOCUMENT",
    "ATTACHMENT",
    "ATTACHMENT",
    "MESSAGE",
    "MESSAGE",
    "MESSAGE",
    "MESSAGE",
    "MESSAGE",
  ];
  const names = actions.map((action) => action.actionName);
  return JSON.stringify(names) === JSON.stringify(expected)
    ? undefined
    : `expected progressive action ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(names)}`;
}

export default scenario({
  id: "deterministic-progressive-content-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "Direct action turns exercise production progressive-read handlers.",
  },
  title: "Deterministic progressive content action contracts",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "progressive-content", "large-content"],
  isolation: "per-scenario",
  requires: {
    plugins: [
      "@elizaos/plugin-coding-tools",
      "@elizaos/plugin-google-workspace",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Progressive Content",
    },
    {
      id: "restricted",
      account: `${SCENARIO_ID}:restricted`,
      source: "client_chat",
      title: "Restricted Progressive Content",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "default",
      requiredMessageIds: ["msg-finance"],
    },
    {
      type: "custom",
      name: "seed large native progressive content sources",
      apply: setupSources,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "FILE first page",
      text: "Read the first bounded page of the seeded file.",
      actionName: "FILE",
      options: { parameters: fileFirst },
      assertTurn: (execution) => {
        const action = actionFor(execution, "FILE");
        if (typeof action === "string") return action;
        return (
          exactPageFailure(action, "x".repeat(4096), {
            unit: "byte",
            start: 0,
            end: 4096,
            total: Buffer.byteLength(FILE_SOURCE),
          }) ?? captureContinuation(action, fileLate)
        );
      },
    },
    {
      kind: "action",
      name: "FILE late continuation",
      text: "Continue the seeded file read at the requested range.",
      actionName: "FILE",
      options: { parameters: fileLate },
      assertTurn: (execution) => {
        const action = actionFor(execution, "FILE");
        if (typeof action === "string") return action;
        const failure = exactPageFailure(action, FILE_CANARY, {
          unit: "byte",
          start:
            Buffer.byteLength(FILE_SOURCE) - Buffer.byteLength(FILE_CANARY),
          end: Buffer.byteLength(FILE_SOURCE),
          total: Buffer.byteLength(FILE_SOURCE),
        });
        if (failure) return failure;
        const view = readViewFrom(action);
        if (typeof view === "string") return view;
        fileStale.expectedRevision = view.slice.revision;
        return undefined;
      },
    },
    {
      kind: "action",
      name: "FILE production mutation",
      text: "Replace the seeded file after its continuation was read.",
      actionName: "FILE",
      options: { parameters: fileMutate },
      assertTurn: (execution) => {
        const action = actionFor(execution, "FILE");
        if (typeof action === "string") return action;
        return action.result?.success === true
          ? undefined
          : `expected production FILE mutation success, saw ${JSON.stringify(action.result)}`;
      },
    },
    {
      kind: "action",
      name: "FILE stale continuation denial",
      text: "Try the old continuation revision after the seeded file changed.",
      actionName: "FILE",
      options: { parameters: fileStale },
      assertTurn: (execution) => {
        const action = actionFor(execution, "FILE");
        if (typeof action === "string") return action;
        if (action.result?.success !== false) {
          return `expected stale continuation failure, saw ${JSON.stringify(action.result)}`;
        }
        return action.result.text.includes("stale_read")
          ? undefined
          : `expected stale_read failure, saw ${JSON.stringify(action.result.text)}`;
      },
    },
    {
      kind: "action",
      name: "DOCUMENT first page",
      text: "Read the first bounded page of the seeded document.",
      actionName: "DOCUMENT",
      options: { parameters: documentFirst },
      assertTurn: (execution) => {
        const action = actionFor(execution, "DOCUMENT");
        if (typeof action === "string") return action;
        return (
          exactPageFailure(action, DOCUMENT_LINES.slice(0, 10).join(""), {
            unit: "line",
            start: 0,
            end: 10,
            total: DOCUMENT_LINES.length,
          }) ?? captureContinuation(action, documentLate)
        );
      },
    },
    {
      kind: "action",
      name: "DOCUMENT late continuation",
      text: "Continue the seeded document read at the requested range.",
      actionName: "DOCUMENT",
      options: { parameters: documentLate },
      assertTurn: (execution) => {
        const action = actionFor(execution, "DOCUMENT");
        if (typeof action === "string") return action;
        return exactPageFailure(action, `${DOCUMENT_CANARY}\n`, {
          unit: "line",
          start: 200,
          end: 201,
          total: DOCUMENT_LINES.length,
        });
      },
    },
    {
      kind: "action",
      name: "ATTACHMENT first page",
      text: "Read the first bounded page and show the attachment record details.",
      actionName: "ATTACHMENT",
      content: { attachmentId: "progressive-attachment" },
      options: { parameters: attachmentFirst },
      assertTurn: (execution) => {
        const action = actionFor(execution, "ATTACHMENT");
        if (typeof action === "string") return action;
        return (
          exactPageFailure(
            action,
            "x".repeat(4096),
            {
              unit: "byte",
              start: 0,
              end: 4096,
              total: Buffer.byteLength(ATTACHMENT_SOURCE),
            },
            true,
          ) ?? captureContinuation(action, attachmentLate)
        );
      },
    },
    {
      kind: "action",
      name: "ATTACHMENT late continuation",
      text: "Continue the requested range and show the attachment record details.",
      actionName: "ATTACHMENT",
      content: { attachmentId: "progressive-attachment" },
      options: { parameters: attachmentLate },
      assertTurn: (execution) => {
        const action = actionFor(execution, "ATTACHMENT");
        if (typeof action === "string") return action;
        return exactPageFailure(action, ATTACHMENT_CANARY, {
          unit: "byte",
          start:
            Buffer.byteLength(ATTACHMENT_SOURCE) -
            Buffer.byteLength(ATTACHMENT_CANARY),
          end: Buffer.byteLength(ATTACHMENT_SOURCE),
          total: Buffer.byteLength(ATTACHMENT_SOURCE),
        });
      },
    },
    {
      kind: "action",
      name: "MESSAGE stored memory first page",
      text: "Read the first bounded page of the seeded stored message.",
      actionName: "MESSAGE",
      content: MESSAGE_ROUTING,
      options: { parameters: memoryFirst },
      assertTurn: (execution) => {
        const action = actionFor(execution, "MESSAGE");
        if (typeof action === "string") return action;
        return (
          exactPageFailure(action, "x".repeat(4096), {
            unit: "byte",
            start: 0,
            end: 4096,
            total: Buffer.byteLength(MEMORY_SOURCE),
          }) ?? captureContinuation(action, memoryLate, true)
        );
      },
    },
    {
      kind: "action",
      name: "MESSAGE stored memory late continuation",
      text: "Continue the seeded stored-message read at the requested range.",
      actionName: "MESSAGE",
      content: MESSAGE_ROUTING,
      options: { parameters: memoryLate },
      assertTurn: (execution) => {
        const action = actionFor(execution, "MESSAGE");
        if (typeof action === "string") return action;
        return exactPageFailure(action, MEMORY_CANARY, {
          unit: "byte",
          start:
            Buffer.byteLength(MEMORY_SOURCE) - Buffer.byteLength(MEMORY_CANARY),
          end: Buffer.byteLength(MEMORY_SOURCE),
          total: Buffer.byteLength(MEMORY_SOURCE),
        });
      },
    },
    {
      kind: "action",
      name: "MESSAGE cross-room denial",
      text: "Try to read a stored message from an inaccessible room.",
      actionName: "MESSAGE",
      content: MESSAGE_ROUTING,
      options: { parameters: restrictedMemoryRead },
      assertTurn: (execution) => {
        const action = actionFor(execution, "MESSAGE");
        if (typeof action === "string") return action;
        if (action.result?.success !== false) {
          return `expected cross-room failure, saw ${JSON.stringify(action.result)}`;
        }
        const data = resultData(action);
        if (typeof data === "string") return data;
        return data.error === "MESSAGE_MEMORY_ACCESS_DENIED"
          ? undefined
          : `expected MESSAGE_MEMORY_ACCESS_DENIED, saw ${JSON.stringify(data.error)}`;
      },
    },
    {
      kind: "action",
      name: "MESSAGE Gmail first page",
      text: "Read the first bounded page of the seeded Gmail message.",
      actionName: "MESSAGE",
      content: MESSAGE_ROUTING,
      options: { parameters: gmailFirst },
      assertTurn: (execution) => {
        const action = actionFor(execution, "MESSAGE");
        if (typeof action === "string") return action;
        return (
          exactPageFailure(action, GMAIL_BODY.slice(0, 16), {
            unit: "byte",
            start: 0,
            end: 16,
            total: Buffer.byteLength(GMAIL_BODY),
          }) ?? captureContinuation(action, gmailNext, true)
        );
      },
    },
    {
      kind: "action",
      name: "MESSAGE Gmail continuation",
      text: "Continue the seeded Gmail read using its returned reference.",
      actionName: "MESSAGE",
      content: MESSAGE_ROUTING,
      options: { parameters: gmailNext },
      assertTurn: (execution) => {
        const action = actionFor(execution, "MESSAGE");
        if (typeof action === "string") return action;
        return exactPageFailure(action, GMAIL_BODY.slice(16), {
          unit: "byte",
          start: 16,
          end: Buffer.byteLength(GMAIL_BODY),
          total: Buffer.byteLength(GMAIL_BODY),
        });
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "progressive action ledger is isolated and exact",
      predicate: finalLedger,
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg-finance",
      minCount: 2,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "remove progressive-content workspace",
      apply: async () => {
        if (fixtureRoot) {
          await fs.rm(fixtureRoot, { force: true, recursive: true });
        }
        return undefined;
      },
    },
  ],
});
