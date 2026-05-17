import { createHash, randomUUID } from "node:crypto";
import type { OwnerChallenge } from "./types.ts";

export interface ChallengeService {
  issue(seed?: string): Promise<OwnerChallenge>;
  verify(id: string, answer: string): Promise<boolean>;
}

export interface InMemoryChallengeServiceOptions {
  now?: () => number;
  ttlMs?: number;
  expectedAnswer?: string;
}

const DEFAULT_TTL_MS = 5 * 60_000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class InMemoryChallengeService implements ChallengeService {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly expectedAnswer: string | null;
  private readonly active = new Map<string, OwnerChallenge>();

  constructor(options: InMemoryChallengeServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.expectedAnswer = options.expectedAnswer ?? null;
  }

  async issue(seed?: string): Promise<OwnerChallenge> {
    const createdAt = this.now();
    const id = randomUUID();
    const prompt = seed ?? "Confirm your private phrase";
    const answerSource = this.expectedAnswer ?? `${id}:${seed ?? "default"}`;
    const challenge: OwnerChallenge = {
      id,
      prompt,
      expectedAnswerHash: sha256Hex(answerSource),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.active.set(id, challenge);
    return challenge;
  }

  async verify(id: string, answer: string): Promise<boolean> {
    const challenge = this.active.get(id);
    if (challenge === undefined) return false;
    if (this.now() > challenge.expiresAt) {
      this.active.delete(id);
      return false;
    }
    const ok = sha256Hex(answer) === challenge.expectedAnswerHash;
    if (ok) this.active.delete(id);
    return ok;
  }
}
