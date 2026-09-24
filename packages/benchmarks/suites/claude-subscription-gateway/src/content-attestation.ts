/**
 * Builds content-free proof that benchmark instructions reached each model call.
 * The orchestrator supplies a reviewed public-text contract at gateway startup;
 * audit records retain only hashes and exact occurrence counts from messages.
 */

import { createHash } from "node:crypto";
import { stableJson } from "./canonical.js";
import type {
  GatewayContentAttestation,
  GatewayContentContract,
  JsonObject,
  NormalizedChatMessage,
} from "./types.js";

const SAFE_CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_PUBLIC_USER_TURNS = 10_000;
const MAX_FORBIDDEN_TEXTS = 20_000;
const MAX_ATTESTED_TEXT_LENGTH = 100_000;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ATTESTED_TEXT_LENGTH
  ) {
    throw new TypeError(
      `[ClaudeSubscriptionGateway] ${label} must be non-empty reviewed text`,
    );
  }
  return value;
}

function parseTextArray(
  value: unknown,
  label: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new TypeError(
      `[ClaudeSubscriptionGateway] ${label} must be a bounded non-empty array`,
    );
  }
  const texts = value.map((entry, index) =>
    requiredText(entry, `${label}.${index}`),
  );
  if (new Set(texts).size !== texts.length) {
    throw new TypeError(
      `[ClaudeSubscriptionGateway] ${label} may not contain duplicates`,
    );
  }
  return texts;
}

function parseCategoryMap(
  value: unknown,
  label: string,
): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new TypeError(
      `[ClaudeSubscriptionGateway] ${label} categories are missing`,
    );
  }
  const result: Record<string, string[]> = {};
  let textCount = 0;
  for (const category of Object.keys(value).sort()) {
    if (!SAFE_CATEGORY.test(category)) {
      throw new TypeError(
        `[ClaudeSubscriptionGateway] ${label} category is invalid`,
      );
    }
    const texts = parseTextArray(
      value[category],
      `${label}.${category}`,
      MAX_FORBIDDEN_TEXTS,
    );
    textCount += texts.length;
    if (textCount > MAX_FORBIDDEN_TEXTS) {
      throw new TypeError(
        `[ClaudeSubscriptionGateway] ${label} contract is too large`,
      );
    }
    result[category] = texts;
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError(
      `[ClaudeSubscriptionGateway] ${label} categories are empty`,
    );
  }
  return result;
}

/** Validate and hash the raw startup contract before any request is accepted. */
export function parseGatewayContentContract(
  value: unknown,
): GatewayContentContract {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new TypeError(
      "[ClaudeSubscriptionGateway] content attestation contract is invalid",
    );
  }
  const contractId = value.contract_id;
  if (typeof contractId !== "string" || !SAFE_CONTRACT_ID.test(contractId)) {
    throw new TypeError(
      "[ClaudeSubscriptionGateway] content contract id is invalid",
    );
  }
  const systemHint = requiredText(value.system_hint, "system_hint");
  const publicUserTurns = parseTextArray(
    value.public_user_turns,
    "public_user_turns",
    MAX_PUBLIC_USER_TURNS,
  );
  const forbiddenTextByCategory = parseCategoryMap(
    value.forbidden_text_by_category,
    "forbidden_text_by_category",
  );
  const observedTextByCategory = parseCategoryMap(
    value.observed_text_by_category,
    "observed_text_by_category",
  );
  const canonical: JsonObject = {
    schema_version: 1,
    contract_id: contractId,
    system_hint: systemHint,
    public_user_turns: publicUserTurns,
    forbidden_text_by_category: forbiddenTextByCategory,
    observed_text_by_category: observedTextByCategory,
  };
  return {
    schemaVersion: 1,
    contractId,
    systemHint,
    publicUserTurns,
    forbiddenTextByCategory,
    observedTextByCategory,
    contractSha256: sha256(stableJson(canonical)),
  };
}

function exactOccurrenceCount(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function occurrenceCount(contents: readonly string[], needle: string): number {
  return contents.reduce(
    (total, content) => total + exactOccurrenceCount(content, needle),
    0,
  );
}

function positiveTextMatches(
  texts: readonly string[],
  contents: readonly string[],
): Record<string, number> {
  const matches: Record<string, number> = {};
  for (const text of texts) {
    const occurrences = occurrenceCount(contents, text);
    if (occurrences > 0) matches[sha256(text)] = occurrences;
  }
  return matches;
}

function categoryMatchCounts(
  categories: Readonly<Record<string, readonly string[]>>,
  contents: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(categories).map(([category, texts]) => [
      category,
      texts.reduce((total, text) => total + occurrenceCount(contents, text), 0),
    ]),
  );
}

/** Scan only canonical message content; request metadata never earns a match. */
export function buildGatewayContentAttestation(
  contract: GatewayContentContract,
  messages: readonly NormalizedChatMessage[],
): GatewayContentAttestation {
  const instructionContents = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => message.content ?? "");
  const userContents = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content ?? "");
  const generatedContents = messages
    .filter(
      (message) => message.role === "assistant" || message.role === "tool",
    )
    .map((message) => message.content ?? "");
  const ingressContents = [...instructionContents, ...userContents];
  const forbiddenIngressMatchCounts = categoryMatchCounts(
    contract.forbiddenTextByCategory,
    ingressContents,
  );
  const forbiddenGeneratedMatchCounts = categoryMatchCounts(
    contract.forbiddenTextByCategory,
    generatedContents,
  );
  const observedInstructionMatchCounts = categoryMatchCounts(
    contract.observedTextByCategory,
    instructionContents,
  );
  const observedUserMatchCounts = categoryMatchCounts(
    contract.observedTextByCategory,
    userContents,
  );
  return {
    schemaVersion: 1,
    contractId: contract.contractId,
    contractSha256: contract.contractSha256,
    systemHintSha256: sha256(contract.systemHint),
    systemHintInstructionOccurrences: occurrenceCount(
      instructionContents,
      contract.systemHint,
    ),
    systemHintUserOccurrences: occurrenceCount(
      userContents,
      contract.systemHint,
    ),
    systemHintGeneratedOccurrences: occurrenceCount(
      generatedContents,
      contract.systemHint,
    ),
    publicUserMatches: positiveTextMatches(
      contract.publicUserTurns,
      userContents,
    ),
    publicUserInstructionMatches: positiveTextMatches(
      contract.publicUserTurns,
      instructionContents,
    ),
    publicUserGeneratedMatches: positiveTextMatches(
      contract.publicUserTurns,
      generatedContents,
    ),
    forbiddenIngressMatchCounts,
    forbiddenIngressMatchTotal: Object.values(
      forbiddenIngressMatchCounts,
    ).reduce((total, count) => total + count, 0),
    forbiddenGeneratedMatchCounts,
    forbiddenGeneratedMatchTotal: Object.values(
      forbiddenGeneratedMatchCounts,
    ).reduce((total, count) => total + count, 0),
    observedInstructionMatchCounts,
    observedUserMatchCounts,
    observedIngressMatchCounts: categoryMatchCounts(
      contract.observedTextByCategory,
      ingressContents,
    ),
    observedGeneratedMatchCounts: categoryMatchCounts(
      contract.observedTextByCategory,
      generatedContents,
    ),
    messageContentManifest: messages.map((message, index) => ({
      index,
      role: message.role,
      sha256: sha256(message.content ?? ""),
    })),
  };
}

/** Return a controlled pre-quota rejection code, or null for an eligible call. */
export function gatewayContentAttestationViolation(
  attestation: GatewayContentAttestation,
): string | null {
  if (attestation.systemHintInstructionOccurrences !== 1) {
    return "benchmark_system_hint_instruction_mismatch";
  }
  if (attestation.systemHintUserOccurrences !== 0) {
    return "benchmark_system_hint_in_user_content";
  }
  if (Object.keys(attestation.publicUserInstructionMatches).length !== 0) {
    return "benchmark_public_user_turn_in_instruction_content";
  }
  if (attestation.forbiddenIngressMatchTotal !== 0) {
    return "benchmark_forbidden_ingress_content";
  }
  if (
    Object.values(attestation.observedUserMatchCounts).some(
      (occurrences) => occurrences !== 0,
    )
  ) {
    return "benchmark_observed_text_in_user_content";
  }
  if (Object.keys(attestation.publicUserMatches).length === 0) {
    return "benchmark_public_user_turn_missing";
  }
  return null;
}
