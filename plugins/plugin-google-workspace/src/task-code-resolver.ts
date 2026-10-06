/** Host-only task code lookup. Never register these methods as model actions. */
import { randomBytes } from "node:crypto";
import { ElizaError } from "@elizaos/core/protocol";
import type {
  GoogleGmailMessageDetail,
  GoogleGmailMessageSummary,
  IGoogleGmailService,
} from "./types.js";

export interface TaskCodeContext {
  accountId: string;
  actorId: string;
  agentId: string;
  taskId: string;
  epoch: number;
  providerOrigin: string;
  recipient: string;
  senders: readonly string[];
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
  searchQuery: string;
}
export interface ParsedTaskCode {
  challengeId: string;
  code: string;
  expiresAt: number;
}
export type TaskCodeResult =
  | { status: "ready"; valueRef: string; expiresAt: number }
  | { status: "missing" | "expired" | "ambiguous" | "incomplete" };
const unavailable = () =>
  new ElizaError("The task code is unavailable. Recheck this task or continue manually.", {
    code: "GOOGLE_TASK_CODE_UNAVAILABLE",
  });
const identity = (c: TaskCodeContext) =>
  JSON.stringify([
    c.accountId,
    c.actorId,
    c.agentId,
    c.taskId,
    c.epoch,
    c.providerOrigin,
    c.recipient,
    c.senders,
    c.challengeId,
    c.issuedAt,
    c.expiresAt,
    c.searchQuery,
  ]);
const email = (value: string) =>
  typeof value === "string" &&
  value.length <= 320 &&
  /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
const cloneContext = (input: TaskCodeContext): TaskCodeContext => {
  try {
    const copy = structuredClone(input);
    Object.freeze(copy.senders);
    return Object.freeze(copy);
  } catch {
    throw unavailable();
  }
};

export class GoogleTaskCodeResolver {
  private generation = 0;
  private readonly values = new Map<string, { scope: string; bytes: Buffer; expiresAt: number }>();
  constructor(
    private readonly options: {
      google: Pick<IGoogleGmailService, "searchGmailMessagesPage" | "getGmailMessageDetail">;
      authorize: (context: TaskCodeContext) => Promise<boolean>;
      /** Reviewed provider parser must identify the actual challenge, not guess a newest code. */
      parse: (detail: GoogleGmailMessageDetail, context: TaskCodeContext) => ParsedTaskCode | null;
      now?: () => number;
    }
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private validate(c: TaskCodeContext) {
    if (
      [c.accountId, c.actorId, c.agentId, c.taskId, c.challengeId].some(
        (v) => typeof v !== "string" || !v || v.length > 256
      ) ||
      !Number.isSafeInteger(c.epoch) ||
      c.epoch < 0 ||
      !email(c.recipient) ||
      !Array.isArray(c.senders) ||
      !c.senders.length ||
      c.senders.length > 16 ||
      c.senders.some((v) => !email(v)) ||
      typeof c.searchQuery !== "string" ||
      !c.searchQuery ||
      c.searchQuery.length > 1000 ||
      !Number.isSafeInteger(c.issuedAt) ||
      !Number.isSafeInteger(c.expiresAt) ||
      c.issuedAt > this.now() ||
      c.expiresAt <= this.now() ||
      c.expiresAt - c.issuedAt > 600000
    )
      throw unavailable();
    const origin = new URL(c.providerOrigin);
    if (origin.protocol !== "https:" || origin.origin !== c.providerOrigin) throw unavailable();
  }
  private prune() {
    for (const [ref, value] of this.values)
      if (value.expiresAt <= this.now()) {
        value.bytes.fill(0);
        this.values.delete(ref);
      }
  }
  revoke() {
    this.generation++;
    for (const value of this.values.values()) value.bytes.fill(0);
    this.values.clear();
  }
  private matches(message: GoogleGmailMessageSummary, c: TaskCodeContext) {
    const received = Date.parse(message.receivedAt);
    return (
      message.fromEmail !== null &&
      c.senders.includes(message.fromEmail) &&
      message.to.includes(c.recipient) &&
      Number.isFinite(received) &&
      received >= c.issuedAt &&
      received <= this.now() &&
      received <= c.expiresAt
    );
  }
  async resolve(input: TaskCodeContext, signal: AbortSignal): Promise<TaskCodeResult> {
    // Snapshot mutable host inputs across every await; never inherit a replacement account.
    const c = cloneContext(input),
      generation = this.generation;
    const check = async () => {
      signal.throwIfAborted();
      this.validate(c);
      if (
        generation !== this.generation ||
        !(await this.options.authorize(c)) ||
        generation !== this.generation
      )
        throw unavailable();
      signal.throwIfAborted();
    };
    const found: ParsedTaskCode[] = [];
    let expired = false;
    try {
      await check();
      this.prune();
      let pageToken: string | undefined;
      const seenTokens = new Set<string>(),
        seenMessages = new Set<string>();
      for (let page = 0; page < 4; page++) {
        await check();
        const result = await this.options.google.searchGmailMessagesPage({
          accountId: c.accountId,
          query: c.searchQuery,
          pageSize: 25,
          pageToken,
        });
        await check();
        if (result.messages.length > 25) throw unavailable();
        for (const message of result.messages) {
          if (seenMessages.has(message.externalId)) continue;
          seenMessages.add(message.externalId);
          if (!this.matches(message, c)) continue;
          await check();
          const detail = await this.options.google.getGmailMessageDetail({
            accountId: c.accountId,
            messageId: message.externalId,
          });
          await check();
          if (
            !detail ||
            detail.message.externalId !== message.externalId ||
            !this.matches(detail.message, c)
          )
            continue;
          const parsed = this.options.parse(detail, c);
          if (!parsed || parsed.challengeId !== c.challengeId) continue;
          if (!/^[A-Za-z0-9]{4,12}$/.test(parsed.code) || !Number.isSafeInteger(parsed.expiresAt))
            throw unavailable();
          if (parsed.expiresAt <= this.now()) {
            expired = true;
            continue;
          }
          found.push({ ...parsed, expiresAt: Math.min(parsed.expiresAt, c.expiresAt) });
        }
        pageToken = result.nextPageToken || undefined;
        if (!pageToken) break;
        if (page === 3 || seenTokens.has(pageToken)) return { status: "incomplete" };
        seenTokens.add(pageToken);
      }
      await check();
      if (found.length !== 1)
        return { status: found.length > 1 ? "ambiguous" : expired ? "expired" : "missing" };
      const selected = found[0];
      if (selected.expiresAt <= this.now()) return { status: "expired" };
      if (this.values.size >= 64) throw unavailable();
      const valueRef = `gcode1:${randomBytes(32).toString("base64url")}`;
      this.values.set(valueRef, {
        scope: identity(c),
        bytes: Buffer.from(selected.code),
        expiresAt: selected.expiresAt,
      });
      return { status: "ready", valueRef, expiresAt: selected.expiresAt };
    } catch {
      throw unavailable();
    } // Provider/parser exceptions may contain message bodies or tokens.
  }
  /** Only the trusted actuator may call this immediately before its guarded fill. */
  async consumeForFill(
    valueRef: string,
    input: TaskCodeContext,
    signal: AbortSignal
  ): Promise<string> {
    const c = cloneContext(input);
    this.prune();
    try {
      this.validate(c);
    } catch {
      throw unavailable();
    }
    const value = this.values.get(valueRef),
      generation = this.generation;
    if (!value || value.scope !== identity(c)) throw unavailable();
    this.values.delete(valueRef); // Claim before awaiting so duplicate fills cannot both consume.
    try {
      signal.throwIfAborted();
      if (
        !(await this.options.authorize(c)) ||
        generation !== this.generation ||
        value.expiresAt <= this.now()
      )
        throw unavailable();
      signal.throwIfAborted();
      return value.bytes.toString();
    } catch {
      throw unavailable();
    } finally {
      value.bytes.fill(0);
    }
  }
}
