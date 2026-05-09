import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioCheckResult,
  ScenarioContext,
} from "@elizaos/scenario-schema";
import type { LifeOpsXFeedType } from "@elizaos/shared";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { seedXConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

type SeededXDm = {
  externalDmId: string;
  conversationId?: string;
  senderHandle: string;
  senderId?: string;
  text: string;
  isInbound?: boolean;
  offsetMinutes?: number;
  metadata?: Record<string, unknown>;
};

type SeededXFeedItem = {
  externalTweetId: string;
  feedType: LifeOpsXFeedType;
  authorHandle: string;
  authorId?: string;
  text: string;
  offsetMinutes?: number;
  metadata?: Record<string, unknown>;
};

function requireRuntime(ctx: ScenarioContext): IAgentRuntime | string {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  return runtime ?? "scenario runtime unavailable during X seed";
}

function scenarioNow(ctx: ScenarioContext): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : new Date();
}

export function seedXReadFixtures(args: {
  dms?: SeededXDm[];
  feedItems?: SeededXFeedItem[];
  handle?: string;
}) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    await seedXConnectorGrant(runtime, {
      capabilities: ["x.read"],
      handle: args.handle,
    });

    const repository = new LifeOpsRepository(runtime);
    const agentId = String(runtime.agentId);
    const now = scenarioNow(ctx);
    const syncedAt = now.toISOString();

    for (const dm of args.dms ?? []) {
      const receivedAt = new Date(
        now.getTime() - (dm.offsetMinutes ?? 5) * 60_000,
      ).toISOString();
      await repository.upsertXDm({
        id: crypto.randomUUID(),
        agentId,
        externalDmId: dm.externalDmId,
        conversationId:
          dm.conversationId ??
          `conversation:${dm.senderHandle.replace(/^@/, "")}`,
        senderHandle: dm.senderHandle.replace(/^@/, ""),
        senderId: dm.senderId ?? dm.senderHandle.replace(/^@/, ""),
        isInbound: dm.isInbound ?? true,
        text: dm.text,
        receivedAt,
        readAt: null,
        repliedAt: null,
        metadata: dm.metadata ?? {},
        syncedAt,
        updatedAt: syncedAt,
      });
    }

    for (const item of args.feedItems ?? []) {
      const createdAtSource = new Date(
        now.getTime() - (item.offsetMinutes ?? 10) * 60_000,
      ).toISOString();
      await repository.upsertXFeedItem({
        id: crypto.randomUUID(),
        agentId,
        externalTweetId: item.externalTweetId,
        authorHandle: item.authorHandle.replace(/^@/, ""),
        authorId: item.authorId ?? item.authorHandle.replace(/^@/, ""),
        text: item.text,
        createdAtSource,
        feedType: item.feedType,
        metadata: item.metadata ?? {},
        syncedAt,
        updatedAt: syncedAt,
      });
    }

    return undefined;
  };
}
