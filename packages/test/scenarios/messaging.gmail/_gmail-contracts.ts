/**
 * Provides binding Gmail scenario checks over turn-scoped mock-provider
 * requests, including exact targets, send payloads, and no-write boundaries.
 */

import type {
  CapturedProviderRequest,
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  const left = [...strings(actual)].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function emailAddress(value: string): string {
  return (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

export function gmailRequestsForTurn(
  ctx: ScenarioContext,
  turnName: string,
): CapturedProviderRequest[] {
  return (ctx.turns ?? [])
    .filter((turn) => turn.name === turnName)
    .flatMap((turn) => turn.providerRequests ?? [])
    .filter((request) => request.provider === "gmail");
}

export function gmailWriteRequests(
  requests: readonly CapturedProviderRequest[],
): CapturedProviderRequest[] {
  return requests.filter(
    (request) => request.method !== "GET" && request.method !== "HEAD",
  );
}

export function gmailNoWriteOnTurns(
  name: string,
  ...turnNames: string[]
): ScenarioFinalCheck {
  return {
    type: "custom",
    name,
    predicate: (ctx) => {
      for (const turnName of turnNames) {
        const matchingTurns = (ctx.turns ?? []).filter(
          (turn) => turn.name === turnName,
        );
        if (
          matchingTurns.length !== 1 ||
          matchingTurns[0]?.providerRequests === undefined
        ) {
          return `${turnName} has no turn-scoped Gmail provider ledger; no-write cannot be proven`;
        }
        const writes = gmailWriteRequests(gmailRequestsForTurn(ctx, turnName));
        if (writes.length > 0) {
          return `${turnName} produced forbidden Gmail write(s): ${writes
            .map((request) => `${request.method} ${request.path}`)
            .join(", ")}`;
        }
      }
    },
  };
}

export function gmailDiscoveryBeforeWrite(options: {
  name: string;
  discoveryTurn: string;
  writeTurn: string;
  requiredReadPaths: readonly string[];
  writePath: string;
}): ScenarioFinalCheck {
  return {
    type: "custom",
    name: options.name,
    predicate: (ctx) => {
      const discovery = gmailRequestsForTurn(ctx, options.discoveryTurn);
      const discoveryWrites = gmailWriteRequests(discovery);
      if (discoveryWrites.length > 0) {
        return `discovery turn wrote to Gmail before confirmation: ${discoveryWrites
          .map((request) => `${request.method} ${request.path}`)
          .join(", ")}`;
      }
      const missingReads = options.requiredReadPaths.filter(
        (path) =>
          !discovery.some(
            (request) => request.method === "GET" && request.path === path,
          ),
      );
      if (missingReads.length > 0) {
        return `discovery turn did not read exact Gmail target(s): ${missingReads.join(", ")}`;
      }
      const writes = gmailWriteRequests(
        gmailRequestsForTurn(ctx, options.writeTurn),
      );
      if (
        writes.length !== 1 ||
        writes[0]?.path !== options.writePath ||
        writes[0]?.method !== "POST"
      ) {
        return `write turn must produce exactly one POST ${options.writePath}; saw ${
          writes
            .map((request) => `${request.method} ${request.path}`)
            .join(", ") || "none"
        }`;
      }
    },
  };
}

export function gmailExactSendBinding(options: {
  name: string;
  turn: string;
  threadId: string;
  recipients: readonly string[];
  bodyIncludesAll: readonly string[];
  inReplyTo?: string;
}): ScenarioFinalCheck {
  return {
    type: "custom",
    name: options.name,
    predicate: (ctx) => {
      const sends = gmailWriteRequests(
        gmailRequestsForTurn(ctx, options.turn),
      ).filter((request) =>
        [
          "/gmail/v1/users/me/messages/send",
          "/gmail/v1/users/me/drafts/send",
        ].includes(request.path),
      );
      if (sends.length !== 1) {
        return `expected exactly one Gmail send on ${options.turn}, saw ${sends.length}`;
      }
      const metadata = record(sends[0]?.metadata);
      const decoded = record(metadata?.decodedSend);
      if (!metadata || !decoded) {
        return "Gmail send ledger omitted decoded send metadata";
      }
      if (metadata.threadId !== options.threadId) {
        return `Gmail send targeted thread ${String(metadata.threadId)} instead of ${options.threadId}`;
      }
      const actualRecipients = strings(decoded.to).map(emailAddress).sort();
      const expectedRecipients = options.recipients.map(emailAddress).sort();
      if (!sameStringSet(actualRecipients, expectedRecipients)) {
        return `Gmail send recipients were [${actualRecipients.join(", ")}] instead of [${expectedRecipients.join(", ")}]`;
      }
      if (strings(decoded.cc).length > 0 || strings(decoded.bcc).length > 0) {
        return "Gmail send added an unapproved cc or bcc recipient";
      }
      if (
        options.inReplyTo !== undefined &&
        decoded.inReplyTo !== options.inReplyTo
      ) {
        return `Gmail send In-Reply-To was ${String(decoded.inReplyTo)} instead of ${options.inReplyTo}`;
      }
      const bodyText = String(decoded.bodyText ?? "").toLowerCase();
      const missing = options.bodyIncludesAll.filter(
        (part) => !bodyText.includes(part.toLowerCase()),
      );
      if (missing.length > 0) {
        return `Gmail send body omitted approved content: ${missing.join(", ")}`;
      }
    },
  };
}

export function gmailExactDraftBinding(options: {
  name: string;
  turn: string;
  sourceMessageId: string;
  bodyIncludesAll: readonly string[];
}): ScenarioFinalCheck {
  return {
    type: "custom",
    name: options.name,
    predicate: (ctx) => {
      const turn = (ctx.turns ?? []).find(
        (execution) => execution.name === options.turn,
      );
      const drafts = (turn?.actionsCalled ?? []).flatMap((action) => {
        const result = record(action.result);
        const data = record(result?.data);
        return data?.source === "gmail" && typeof data.draftId === "string"
          ? [{ action, data }]
          : [];
      });
      if (drafts.length !== 1) {
        return `expected exactly one Gmail draft artifact on ${options.turn}, saw ${drafts.length}`;
      }
      const data = drafts[0]?.data;
      const inReplyToId = String(data?.inReplyToId ?? "");
      if (!inReplyToId.endsWith(options.sourceMessageId)) {
        return `Gmail draft targeted ${inReplyToId || "no source"} instead of ${options.sourceMessageId}`;
      }
      const preview = String(data?.preview ?? "").toLowerCase();
      const missing = options.bodyIncludesAll.filter(
        (part) => !preview.includes(part.toLowerCase()),
      );
      if (missing.length > 0) {
        return `Gmail draft body omitted requested content: ${missing.join(", ")}`;
      }
      const sourceRead = gmailRequestsForTurn(ctx, options.turn).some(
        (request) =>
          request.method === "GET" &&
          request.path ===
            `/gmail/v1/users/me/messages/${options.sourceMessageId}`,
      );
      if (!sourceRead) {
        return `Gmail draft did not read exact source message ${options.sourceMessageId}`;
      }
    },
  };
}

export function gmailSpamTrashDiscovery(
  name: string,
  turn: string,
): ScenarioFinalCheck {
  return {
    type: "custom",
    name,
    predicate: (ctx) => {
      const listRequests = gmailRequestsForTurn(ctx, turn).filter(
        (request) =>
          request.method === "GET" &&
          request.path === "/gmail/v1/users/me/messages",
      );
      const scoped = listRequests.some((request) => {
        const metadata = record(request.metadata);
        const query = `${String(metadata?.query ?? "")} ${request.query ?? ""}`;
        return (
          /\bin:(?:spam|trash|anywhere)\b/i.test(query) ||
          /(?:^|[?&])includeSpamTrash=true(?:&|$)/i.test(request.query ?? "")
        );
      });
      if (!scoped) {
        return "Gmail discovery never included spam/trash in its provider query";
      }
    },
  };
}

export function gmailDraftSendCorrelation(options: {
  name: string;
  draftTurn: string;
  sendTurn: string;
}): ScenarioFinalCheck {
  return {
    type: "custom",
    name: options.name,
    predicate: (ctx) => {
      const draftTurn = (ctx.turns ?? []).find(
        (turn) => turn.name === options.draftTurn,
      );
      const sendTurn = (ctx.turns ?? []).find(
        (turn) => turn.name === options.sendTurn,
      );
      const draftIds = (draftTurn?.actionsCalled ?? []).flatMap((action) => {
        const data = record(record(action.result)?.data);
        return typeof data?.draftId === "string" ? [data.draftId] : [];
      });
      if (draftIds.length !== 1) {
        return `expected one draft ID on ${options.draftTurn}, saw ${draftIds.length}`;
      }
      const matchingSends = (sendTurn?.actionsCalled ?? []).filter((action) => {
        const raw = record(action.parameters);
        const params = record(raw?.parameters) ?? raw;
        return params?.draftId === draftIds[0] && params?.confirmed === true;
      });
      if (matchingSends.length !== 1) {
        return `confirmed send did not consume exactly the draft ID created on ${options.draftTurn}`;
      }
    },
  };
}
