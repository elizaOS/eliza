/**
 * Owner-reviewed sensitive-content deletion for the personal corpus. The
 * library separates deterministic matching from human decisions, binds every
 * artifact to the exact corpus/rules/candidates bytes, and emits tombstones
 * that contain no source content. File parsing and pipeline orchestration live
 * at the CLI/driver boundary; this module accepts JSON/YAML-decoded data.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type CorpusMessage,
  type CorpusPlatform,
  corpusPlatforms,
  scrubStateRank,
} from "../schema.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DETECTOR_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVIEW_REDACT_PATTERNS: readonly RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /(?<!\d)(?:\+?[1-9]\d{7,14}|(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4})(?!\d)/g,
  /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
  /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:password|passcode|token|secret)\s*[:=]\s*\S+/gi,
];

const ruleBaseSchema = z
  .object({
    id: z.string().regex(RULE_ID_PATTERN),
    enabled: z.boolean(),
  })
  .strict();

const threadRuleSchema = ruleBaseSchema
  .extend({
    scope: z.literal("thread"),
    match: z
      .object({
        type: z.literal("thread"),
        platform: z.enum(corpusPlatforms),
        accountId: z.string().trim().min(1),
        threadId: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const contactRuleSchema = ruleBaseSchema
  .extend({
    scope: z.literal("thread"),
    match: z
      .object({
        type: z.literal("contact"),
        platform: z.enum(corpusPlatforms),
        accountId: z.string().trim().min(1),
        contactId: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const detectorRuleSchema = ruleBaseSchema
  .extend({
    scope: z.enum(["message", "thread"]),
    match: z
      .object({
        type: z.literal("detector"),
        kind: z.string().regex(DETECTOR_KIND_PATTERN),
      })
      .strict(),
  })
  .strict();

export const deletionKeywordFields = [
  "subject",
  "text",
  "snippet",
  "labels",
  "attachment-filename",
] as const;

const keywordRuleSchema = ruleBaseSchema
  .extend({
    scope: z.enum(["message", "thread"]),
    match: z
      .object({
        type: z.literal("keyword"),
        value: z.string().trim().min(2),
        mode: z.enum(["token", "substring"]),
        fields: z
          .array(z.enum(deletionKeywordFields))
          .min(1)
          .refine((fields) => new Set(fields).size === fields.length, {
            message: "keyword fields must be unique",
          }),
      })
      .strict(),
  })
  .strict();

const labelRuleSchema = ruleBaseSchema
  .extend({
    scope: z.enum(["message", "thread"]),
    match: z
      .object({
        type: z.literal("label"),
        value: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const anyDeletionRuleSchema = z.union([
  threadRuleSchema,
  contactRuleSchema,
  detectorRuleSchema,
  keywordRuleSchema,
  labelRuleSchema,
]);

export const deletionRulesSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().trim().min(1),
    attachmentPolicy: z
      .object({
        embeddedBytes: z.literal("drop"),
        retainMetadata: z.tuple([
          z.literal("filename"),
          z.literal("mimeType"),
          z.literal("sha256"),
        ]),
      })
      .strict(),
    rules: z.array(anyDeletionRuleSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, rule] of value.rules.entries()) {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: `duplicate deletion rule id ${rule.id}`,
        });
      }
      ids.add(rule.id);
    }
  });

export type DeletionRules = z.infer<typeof deletionRulesSchema>;
export type DeletionRule = DeletionRules["rules"][number];
export type DeletionMatchClass = DeletionRule["match"]["type"];

export interface DeletionCandidate {
  readonly msgId: string;
  readonly kind: string;
}

export interface DeletionReviewGroup {
  readonly groupId: string;
  readonly scope: "message" | "thread";
  readonly platform: CorpusPlatform;
  readonly messageIds: readonly string[];
  readonly ruleIdHashes: readonly string[];
  readonly matchClasses: readonly DeletionMatchClass[];
  readonly redactedContext: string;
  readonly suggestedDecision: "delete";
}

export interface DeletionReviewQueue {
  readonly schemaVersion: 1;
  readonly rulesetVersion: string;
  readonly corpusDigest: string;
  readonly rulesSha256: string;
  readonly candidatesSha256: string;
  readonly groups: readonly DeletionReviewGroup[];
}

const deletionMatchClassSchema = z.enum([
  "contact",
  "detector",
  "keyword",
  "label",
  "thread",
]);

const deletionReviewGroupSchema = z
  .object({
    groupId: z.string().regex(SHA256_PATTERN),
    scope: z.enum(["message", "thread"]),
    platform: z.enum(corpusPlatforms),
    messageIds: z.array(z.string().min(1)).min(1),
    ruleIdHashes: z.array(z.string().regex(SHA256_PATTERN)).min(1),
    matchClasses: z.array(deletionMatchClassSchema).min(1),
    redactedContext: z
      .string()
      .min(1)
      .refine((value) => [...value].length <= 60, {
        message: "redacted context must be at most 60 Unicode characters",
      }),
    suggestedDecision: z.literal("delete"),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [name, values] of [
      ["messageIds", value.messageIds],
      ["ruleIdHashes", value.ruleIdHashes],
      ["matchClasses", value.matchClasses],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} must be unique`,
        });
      }
    }
  });

export const deletionReviewQueueSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().trim().min(1),
    corpusDigest: z.string().regex(SHA256_PATTERN),
    rulesSha256: z.string().regex(SHA256_PATTERN),
    candidatesSha256: z.string().regex(SHA256_PATTERN),
    groups: z.array(deletionReviewGroupSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const groupIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const [groupIndex, group] of value.groups.entries()) {
      if (groupIds.has(group.groupId)) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "groupId"],
          message: `duplicate deletion review group ${group.groupId}`,
        });
      }
      groupIds.add(group.groupId);
      for (const [messageIndex, messageId] of group.messageIds.entries()) {
        if (messageIds.has(messageId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "messageIds", messageIndex],
            message: `message ${messageId} occurs in multiple review groups`,
          });
        }
        messageIds.add(messageId);
      }
    }
  });

const reviewDecisionSchema = z
  .object({
    groupId: z.string().regex(SHA256_PATTERN),
    decision: z.enum(["delete", "keep"]),
  })
  .strict();

export const deletionReviewDecisionsSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().trim().min(1),
    corpusDigest: z.string().regex(SHA256_PATTERN),
    rulesSha256: z.string().regex(SHA256_PATTERN),
    reviewedQueueSha256: z.string().regex(SHA256_PATTERN),
    approved: z.literal(true),
    reviewedBy: z.string().trim().min(1),
    reviewedAt: z.string().datetime({ offset: true }),
    decisions: z.array(reviewDecisionSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, decision] of value.decisions.entries()) {
      if (ids.has(decision.groupId)) {
        context.addIssue({
          code: "custom",
          path: ["decisions", index, "groupId"],
          message: `duplicate deletion decision for ${decision.groupId}`,
        });
      }
      ids.add(decision.groupId);
    }
  });

export type DeletionReviewDecisions = z.infer<
  typeof deletionReviewDecisionsSchema
>;

export interface DeletionTombstoneMetadata {
  readonly messageId: string;
  readonly stage: "delete";
  readonly stageVersion: string;
  readonly outputHash: string;
  readonly rulesSha256: string;
  readonly reviewedQueueSha256: string;
  readonly reviewDecisionSha256: string;
  readonly ruleIdHashes: readonly string[];
  readonly scope: "message" | "thread";
}

export interface DeletionApproval {
  readonly schemaVersion: 1;
  readonly rulesetVersion: string;
  readonly approved: true;
  readonly corpusDigest: string;
  readonly candidatesSha256: string;
  readonly rulesSha256: string;
  readonly reviewedQueueSha256: string;
  readonly reviewDecisionSha256: string;
  readonly deleteStageVersion: string;
  readonly tombstoneCount: number;
  readonly tombstoneIdsSha256: string;
  readonly survivorCount: number;
  readonly attachmentBytesDropped: number;
}

export interface DeletionReport {
  readonly schemaVersion: 1;
  readonly rulesetVersion: string;
  readonly corpusDigest: string;
  readonly rulesSha256: string;
  readonly reviewedQueueSha256: string;
  readonly reviewDecisionSha256: string;
  readonly inputMessages: number;
  readonly survivorMessages: number;
  readonly tombstoneCount: number;
  readonly attachmentBytesDropped: number;
  readonly countsByMatchClass: Readonly<Record<DeletionMatchClass, number>>;
  readonly countsByScope: Readonly<Record<"message" | "thread", number>>;
  readonly reportDigest: string;
}

export interface AppliedDeletion {
  readonly survivors: readonly CorpusMessage[];
  readonly tombstones: readonly DeletionTombstoneMetadata[];
  readonly approval: DeletionApproval;
  readonly report: DeletionReport;
}

interface RuleMatch {
  readonly rule: DeletionRule;
  readonly sensitiveTerms: readonly string[];
}

interface MutableReviewGroup {
  scope: "message" | "thread";
  platform: CorpusPlatform;
  messageIds: Set<string>;
  rules: Map<string, DeletionRule>;
  sensitiveTerms: Set<string>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalDeletionArtifactSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function parseDeletionRules(value: unknown): DeletionRules {
  return deletionRulesSchema.parse(value);
}

export function parseDeletionReviewDecisions(
  value: unknown,
): DeletionReviewDecisions {
  return deletionReviewDecisionsSchema.parse(value);
}

export function parseDeletionReviewQueue(value: unknown): DeletionReviewQueue {
  return deletionReviewQueueSchema.parse(value);
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function threadKey(message: CorpusMessage): string {
  return canonicalJson([message.platform, message.accountId, message.threadId]);
}

function messageFieldsForKeyword(
  message: CorpusMessage,
  fields: readonly (typeof deletionKeywordFields)[number][],
): string[] {
  const values: string[] = [];
  for (const field of fields) {
    switch (field) {
      case "subject":
        if (message.subject) values.push(message.subject);
        break;
      case "text":
        values.push(message.text);
        break;
      case "snippet":
        if (message.snippet) values.push(message.snippet);
        break;
      case "labels":
        values.push(...message.labels);
        break;
      case "attachment-filename":
        values.push(...message.attachments.map((item) => item.filename));
        break;
    }
  }
  return values;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function containsToken(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;
    const before = index === 0 ? undefined : haystack[index - 1];
    const after = haystack[index + needle.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    from = index + Math.max(needle.length, 1);
  }
}

function matchesRule(
  message: CorpusMessage,
  rule: DeletionRule,
  candidateKindsByMessage: ReadonlyMap<string, ReadonlySet<string>>,
): RuleMatch | undefined {
  const match = rule.match;
  switch (match.type) {
    case "thread":
      return message.platform === match.platform &&
        message.accountId === match.accountId &&
        message.threadId === match.threadId
        ? { rule, sensitiveTerms: [match.threadId] }
        : undefined;
    case "contact": {
      if (
        message.platform !== match.platform ||
        message.accountId !== match.accountId
      ) {
        return undefined;
      }
      const wanted = normalized(match.contactId);
      const participants = [
        message.senderId,
        ...message.recipients.flatMap((recipient) => [
          recipient.id,
          ...(recipient.address ? [recipient.address] : []),
        ]),
      ];
      return participants.some(
        (participant) => normalized(participant) === wanted,
      )
        ? { rule, sensitiveTerms: [match.contactId] }
        : undefined;
    }
    case "detector":
      return candidateKindsByMessage.get(message.id)?.has(match.kind)
        ? { rule, sensitiveTerms: [] }
        : undefined;
    case "keyword": {
      const needle = normalized(match.value);
      const matched = messageFieldsForKeyword(message, match.fields).some(
        (value) => {
          const haystack = normalized(value);
          return match.mode === "substring"
            ? haystack.includes(needle)
            : containsToken(haystack, needle);
        },
      );
      return matched ? { rule, sensitiveTerms: [match.value] } : undefined;
    }
    case "label":
      return message.labels.some(
        (label) => normalized(label) === normalized(match.value),
      )
        ? { rule, sensitiveTerms: [match.value] }
        : undefined;
  }
}

function replaceLiteralInsensitive(text: string, value: string): string {
  if (!value) return text;
  const lowerText = normalized(text);
  const lowerValue = normalized(value);
  if (lowerText.length !== text.length || lowerValue.length !== value.length) {
    // Unicode normalization can change code-unit length. Avoid a lossy offset
    // rewrite; the detector pass below still removes structured values and the
    // queue remains local-only.
    return text;
  }
  let result = text;
  let search = lowerText;
  let from = 0;
  for (;;) {
    const index = search.indexOf(lowerValue, from);
    if (index === -1) return result;
    result = `${result.slice(0, index)}[MATCH]${result.slice(index + value.length)}`;
    search = normalized(result);
    from = index + "[MATCH]".length;
  }
}

function redactedContext(
  message: CorpusMessage,
  sensitiveTerms: readonly string[],
): string {
  let value = [message.subject, message.text, message.snippet]
    .filter((item): item is string => Boolean(item))
    .join(" — ");
  for (const term of [...new Set(sensitiveTerms)].sort(
    (left, right) => right.length - left.length,
  )) {
    value = replaceLiteralInsensitive(value, term);
  }
  for (const pattern of REVIEW_REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, "[REDACTED]");
  }
  value = value.replace(/\s+/g, " ").trim();
  if (!value) return "[no textual preview]";
  const characters = [...value];
  return characters.length <= 60
    ? value
    : `${characters.slice(0, 59).join("")}…`;
}

function assertUniqueMessages(messages: readonly CorpusMessage[]): void {
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id)) {
      throw new Error(`duplicate corpus message id ${message.id}`);
    }
    ids.add(message.id);
  }
}

function assertDeletionStageInputs(messages: readonly CorpusMessage[]): void {
  for (const message of messages) {
    if (scrubStateRank[message.scrubState] < scrubStateRank.swapped) {
      throw new Error(
        `deletion requires swapped input; message ${message.id} is ${message.scrubState}`,
      );
    }
  }
}

function rulesForHash(rules: DeletionRules): DeletionRules {
  return {
    ...rules,
    rules: [...rules.rules].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

function corpusDigest(messages: readonly CorpusMessage[]): string {
  return canonicalDeletionArtifactSha256(
    [...messages].sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function candidateDigest(candidates: readonly DeletionCandidate[]): string {
  return canonicalDeletionArtifactSha256(
    candidates
      .map((candidate) => ({
        msgId: candidate.msgId,
        kind: candidate.kind,
      }))
      .sort(
        (left, right) =>
          left.msgId.localeCompare(right.msgId) ||
          left.kind.localeCompare(right.kind),
      ),
  );
}

export function buildDeletionReviewQueue(options: {
  messages: readonly CorpusMessage[];
  candidates: readonly DeletionCandidate[];
  rules: unknown;
}): DeletionReviewQueue {
  const rules = parseDeletionRules(options.rules);
  assertUniqueMessages(options.messages);
  assertDeletionStageInputs(options.messages);
  const messagesById = new Map(
    options.messages.map((message) => [message.id, message]),
  );
  const candidateKindsByMessage = new Map<string, Set<string>>();
  for (const candidate of options.candidates) {
    if (!messagesById.has(candidate.msgId)) {
      throw new Error(
        `deletion candidate references missing message ${candidate.msgId}`,
      );
    }
    if (!DETECTOR_KIND_PATTERN.test(candidate.kind)) {
      throw new Error(`invalid deletion candidate kind ${candidate.kind}`);
    }
    const kinds = candidateKindsByMessage.get(candidate.msgId) ?? new Set();
    kinds.add(candidate.kind);
    candidateKindsByMessage.set(candidate.msgId, kinds);
  }

  const direct = new Map<string, RuleMatch[]>();
  for (const message of options.messages) {
    const matches = rules.rules
      .filter((rule) => rule.enabled)
      .map((rule) => matchesRule(message, rule, candidateKindsByMessage))
      .filter((match): match is RuleMatch => match !== undefined);
    if (matches.length > 0) direct.set(message.id, matches);
  }

  const threadGroups = new Map<string, MutableReviewGroup>();
  const threadCoveredMessages = new Set<string>();
  for (const [messageId, matches] of direct) {
    const message = messagesById.get(messageId);
    if (!message) throw new Error(`missing matched message ${messageId}`);
    const threadMatches = matches.filter(
      (match) => match.rule.scope === "thread",
    );
    if (threadMatches.length === 0) continue;
    const key = threadKey(message);
    const group = threadGroups.get(key) ?? {
      scope: "thread" as const,
      platform: message.platform,
      messageIds: new Set<string>(),
      rules: new Map<string, DeletionRule>(),
      sensitiveTerms: new Set<string>(),
    };
    for (const related of options.messages.filter(
      (candidate) => threadKey(candidate) === key,
    )) {
      group.messageIds.add(related.id);
      threadCoveredMessages.add(related.id);
    }
    for (const match of threadMatches) {
      group.rules.set(match.rule.id, match.rule);
      for (const term of match.sensitiveTerms) group.sensitiveTerms.add(term);
    }
    threadGroups.set(key, group);
  }

  // Message-scoped matches inside an already selected thread are folded into
  // that thread group so the owner cannot issue contradictory partial choices.
  for (const group of threadGroups.values()) {
    for (const messageId of group.messageIds) {
      for (const match of direct.get(messageId) ?? []) {
        group.rules.set(match.rule.id, match.rule);
        for (const term of match.sensitiveTerms) group.sensitiveTerms.add(term);
      }
    }
  }

  const messageGroups: MutableReviewGroup[] = [];
  for (const [messageId, matches] of direct) {
    if (threadCoveredMessages.has(messageId)) continue;
    const scoped = matches.filter((match) => match.rule.scope === "message");
    if (scoped.length === 0) continue;
    const message = messagesById.get(messageId);
    if (!message) throw new Error(`missing matched message ${messageId}`);
    messageGroups.push({
      scope: "message",
      platform: message.platform,
      messageIds: new Set([messageId]),
      rules: new Map(scoped.map((match) => [match.rule.id, match.rule])),
      sensitiveTerms: new Set(scoped.flatMap((match) => match.sensitiveTerms)),
    });
  }

  const groups = [...threadGroups.values(), ...messageGroups]
    .map((group): DeletionReviewGroup => {
      const messageIds = [...group.messageIds].sort();
      const rulesInGroup = [...group.rules.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const ruleIdHashes = rulesInGroup.map((rule) => sha256(rule.id));
      const matchClasses = [
        ...new Set(rulesInGroup.map((rule) => rule.match.type)),
      ].sort() as DeletionMatchClass[];
      const previewMessage = messagesById.get(messageIds[0]);
      if (!previewMessage)
        throw new Error("review group has no source message");
      const groupId = canonicalDeletionArtifactSha256({
        scope: group.scope,
        platform: group.platform,
        messageIds,
        ruleIdHashes,
      });
      return {
        groupId,
        scope: group.scope,
        platform: group.platform,
        messageIds,
        ruleIdHashes,
        matchClasses,
        redactedContext: redactedContext(previewMessage, [
          ...group.sensitiveTerms,
        ]),
        suggestedDecision: "delete",
      };
    })
    .sort((left, right) => left.groupId.localeCompare(right.groupId));

  return {
    schemaVersion: 1,
    rulesetVersion: rules.rulesetVersion,
    corpusDigest: corpusDigest(options.messages),
    rulesSha256: canonicalDeletionArtifactSha256(rulesForHash(rules)),
    candidatesSha256: candidateDigest(options.candidates),
    groups,
  };
}

function stripAttachmentBytes(message: CorpusMessage): CorpusMessage {
  const attachments = message.attachments.map((attachment) => {
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
    };
  });
  return { ...message, attachments };
}

function emptyMatchCounts(): Record<DeletionMatchClass, number> {
  return {
    contact: 0,
    detector: 0,
    keyword: 0,
    label: 0,
    thread: 0,
  };
}

export function applyDeletionReview(options: {
  messages: readonly CorpusMessage[];
  queue: DeletionReviewQueue;
  decisions: unknown;
}): AppliedDeletion {
  assertUniqueMessages(options.messages);
  assertDeletionStageInputs(options.messages);
  const queue = parseDeletionReviewQueue(options.queue);
  const decisions = parseDeletionReviewDecisions(options.decisions);
  const currentCorpusDigest = corpusDigest(options.messages);
  const queueSha256 = canonicalDeletionArtifactSha256(queue);
  for (const [name, expected, actual] of [
    ["ruleset", queue.rulesetVersion, decisions.rulesetVersion],
    ["corpus", queue.corpusDigest, decisions.corpusDigest],
    ["rules", queue.rulesSha256, decisions.rulesSha256],
    ["review queue", queueSha256, decisions.reviewedQueueSha256],
    ["current corpus", queue.corpusDigest, currentCorpusDigest],
  ] as const) {
    if (expected !== actual) {
      throw new Error(`deletion ${name} binding mismatch`);
    }
  }

  const groupsById = new Map(
    queue.groups.map((group) => [group.groupId, group]),
  );
  if (groupsById.size !== queue.groups.length) {
    throw new Error("duplicate deletion review group id");
  }
  const decisionsById = new Map(
    decisions.decisions.map((decision) => [decision.groupId, decision]),
  );
  for (const groupId of groupsById.keys()) {
    if (!decisionsById.has(groupId)) {
      throw new Error(`missing deletion decision for review group ${groupId}`);
    }
  }
  for (const groupId of decisionsById.keys()) {
    if (!groupsById.has(groupId)) {
      throw new Error(
        `unexpected deletion decision for review group ${groupId}`,
      );
    }
  }

  const messagesById = new Map(
    options.messages.map((message) => [message.id, message]),
  );
  const deletionByMessage = new Map<string, DeletionReviewGroup>();
  for (const group of queue.groups) {
    if (decisionsById.get(group.groupId)?.decision !== "delete") continue;
    for (const messageId of group.messageIds) {
      if (!messagesById.has(messageId)) {
        throw new Error(`review queue references missing message ${messageId}`);
      }
      if (deletionByMessage.has(messageId)) {
        throw new Error(
          `message ${messageId} belongs to multiple review groups`,
        );
      }
      deletionByMessage.set(messageId, group);
    }
  }

  const reviewDecisionSha256 = canonicalDeletionArtifactSha256(decisions);
  const deleteStageVersion = `delete-v1:${queue.rulesSha256.slice(0, 12)}:${queueSha256.slice(0, 12)}:${reviewDecisionSha256.slice(0, 12)}`;
  const survivors: CorpusMessage[] = [];
  const tombstones: DeletionTombstoneMetadata[] = [];
  let attachmentBytesDropped = 0;
  for (const message of options.messages) {
    for (const attachment of message.attachments) {
      if (attachment.dataBase64 !== undefined) {
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            attachment.dataBase64,
          )
        ) {
          throw new Error(
            `attachment ${attachment.sha256} has invalid base64 payload`,
          );
        }
        const decoded = Buffer.from(attachment.dataBase64, "base64");
        if (
          decoded.toString("base64") !== attachment.dataBase64 ||
          (attachment.bytes !== undefined &&
            attachment.bytes !== decoded.length)
        ) {
          throw new Error(
            `attachment ${attachment.sha256} has inconsistent payload bytes`,
          );
        }
        attachmentBytesDropped += decoded.length;
      } else if (attachment.bytes !== undefined) {
        attachmentBytesDropped += attachment.bytes;
      }
      if (!Number.isSafeInteger(attachmentBytesDropped)) {
        throw new Error("attachment byte total exceeds safe integer range");
      }
    }
    const group = deletionByMessage.get(message.id);
    if (group) {
      const unsigned = {
        messageId: message.id,
        stage: "delete" as const,
        stageVersion: deleteStageVersion,
        rulesSha256: queue.rulesSha256,
        reviewedQueueSha256: queueSha256,
        reviewDecisionSha256,
        ruleIdHashes: [...group.ruleIdHashes],
        scope: group.scope,
      };
      tombstones.push({
        ...unsigned,
        outputHash: canonicalDeletionArtifactSha256({
          tombstone: true,
          ...unsigned,
        }),
      });
      continue;
    }
    survivors.push(stripAttachmentBytes(message));
  }

  const matchCounts = emptyMatchCounts();
  const scopeCounts: Record<"message" | "thread", number> = {
    message: 0,
    thread: 0,
  };
  const deletedGroups = new Map(
    [...deletionByMessage.values()].map((group) => [group.groupId, group]),
  );
  for (const group of deletedGroups.values()) {
    scopeCounts[group.scope] += 1;
    for (const matchClass of group.matchClasses) matchCounts[matchClass] += 1;
  }
  const approval: DeletionApproval = {
    schemaVersion: 1,
    rulesetVersion: queue.rulesetVersion,
    approved: true,
    corpusDigest: queue.corpusDigest,
    candidatesSha256: queue.candidatesSha256,
    rulesSha256: queue.rulesSha256,
    reviewedQueueSha256: queueSha256,
    reviewDecisionSha256,
    deleteStageVersion,
    tombstoneCount: tombstones.length,
    tombstoneIdsSha256: canonicalDeletionArtifactSha256(
      tombstones.map((tombstone) => tombstone.messageId).sort(),
    ),
    survivorCount: survivors.length,
    attachmentBytesDropped,
  };
  const unsignedReport = {
    schemaVersion: 1 as const,
    rulesetVersion: queue.rulesetVersion,
    corpusDigest: queue.corpusDigest,
    rulesSha256: queue.rulesSha256,
    reviewedQueueSha256: queueSha256,
    reviewDecisionSha256,
    inputMessages: options.messages.length,
    survivorMessages: survivors.length,
    tombstoneCount: tombstones.length,
    attachmentBytesDropped,
    countsByMatchClass: matchCounts,
    countsByScope: scopeCounts,
  };
  return {
    survivors,
    tombstones,
    approval,
    report: {
      ...unsignedReport,
      reportDigest: canonicalDeletionArtifactSha256(unsignedReport),
    },
  };
}
