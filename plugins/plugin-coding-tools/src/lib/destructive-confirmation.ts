/**
 * Holds short-lived one-time shell confirmation challenges per runtime.
 * Entries contain only an opaque nonce and command digest, never command text,
 * and authorization is bound to the requesting entity and room.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IAgentRuntime, Memory } from "@elizaos/core";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES_PER_RUNTIME = 64;

interface Challenge {
  commandDigest: string;
  entityId: string;
  issuingMessageId: string;
  roomId: string;
  expiresAt: number;
}

const challenges = new WeakMap<IAgentRuntime, Map<string, Challenge>>();

export function destructiveCommandDigest(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

function runtimeChallenges(runtime: IAgentRuntime): Map<string, Challenge> {
  let entries = challenges.get(runtime);
  if (!entries) {
    entries = new Map();
    challenges.set(runtime, entries);
  }
  return entries;
}

function sweep(entries: Map<string, Challenge>, now: number): void {
  for (const [token, challenge] of entries) {
    if (challenge.expiresAt <= now) entries.delete(token);
  }
  while (entries.size >= MAX_CHALLENGES_PER_RUNTIME) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") break;
    entries.delete(oldest);
  }
}

export function issueDestructiveChallenge(args: {
  runtime: IAgentRuntime;
  command: string;
  message: Memory;
  now?: number;
}): string | undefined {
  if (!args.message.id || !args.message.roomId || !args.message.entityId)
    return undefined;
  const now = args.now ?? Date.now();
  const entries = runtimeChallenges(args.runtime);
  sweep(entries, now);
  const commandDigest = destructiveCommandDigest(args.command);
  const roomId = String(args.message.roomId);
  const entityId = String(args.message.entityId);
  const issuingMessageId = String(args.message.id);
  if (!issuingMessageId.trim()) return undefined;
  for (const [token, challenge] of entries) {
    if (
      challenge.commandDigest === commandDigest &&
      challenge.roomId === roomId &&
      challenge.entityId === entityId
    ) {
      entries.delete(token);
    }
  }
  const token = randomBytes(18).toString("base64url");
  entries.set(token, {
    commandDigest,
    roomId,
    entityId,
    issuingMessageId,
    expiresAt: now + CHALLENGE_TTL_MS,
  });
  return token;
}

export type ChallengeConsumption =
  | { authorized: true }
  | {
      authorized: false;
      reason:
        | "missing"
        | "expired"
        | "requester_mismatch"
        | "room_mismatch"
        | "command_mismatch"
        | "same_message"
        | "token_not_confirmed";
    };

function confirmsToken(text: unknown, token: string): boolean {
  if (typeof text !== "string") return false;
  const match = /^confirm\s+(\S+)$/i.exec(text.trim());
  return match?.[1] === token;
}

export function consumeDestructiveChallenge(args: {
  runtime: IAgentRuntime;
  token: string | undefined;
  command: string;
  message: Memory;
  now?: number;
}): ChallengeConsumption {
  if (!args.token) return { authorized: false, reason: "missing" };
  const entries = runtimeChallenges(args.runtime);
  const challenge = entries.get(args.token);
  if (!challenge) return { authorized: false, reason: "missing" };
  const now = args.now ?? Date.now();
  if (challenge.expiresAt <= now) {
    entries.delete(args.token);
    return { authorized: false, reason: "expired" };
  }
  if (challenge.roomId !== String(args.message.roomId ?? "")) {
    return { authorized: false, reason: "room_mismatch" };
  }
  if (challenge.entityId !== String(args.message.entityId ?? "")) {
    return { authorized: false, reason: "requester_mismatch" };
  }
  if (challenge.issuingMessageId === String(args.message.id ?? "")) {
    return { authorized: false, reason: "same_message" };
  }
  if (challenge.commandDigest !== destructiveCommandDigest(args.command)) {
    return { authorized: false, reason: "command_mismatch" };
  }
  if (!confirmsToken(args.message.content?.text, args.token)) {
    return { authorized: false, reason: "token_not_confirmed" };
  }
  // Consume before dispatch: a failed shell launch must not make an approval
  // replayable on a later turn.
  entries.delete(args.token);
  return { authorized: true };
}
