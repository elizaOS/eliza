import { type Content, elizaLogger } from "@elizaos/core";
import { isApiErrorResponse, type NeynarAPIClient } from "@neynar/nodejs-sdk";
import type { Cast as NeynarCast } from "@neynar/nodejs-sdk/build/api";
import { LRUCache } from "lru-cache";
import {
  type Cast,
  type CastId,
  DEFAULT_CAST_CACHE_SIZE,
  DEFAULT_CAST_CACHE_TTL,
  type FidRequest,
  type Profile,
} from "../types";
import { neynarCastToCast, splitPostContent } from "../utils";

async function logNeynarCall<T>(
  op: string,
  context: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  elizaLogger.debug({ sdk: "neynar", op, ...context }, `[FarcasterClient] ${op} started`);
  try {
    const result = await fn();
    elizaLogger.info(
      {
        sdk: "neynar",
        op,
        ...context,
        durationMs: Date.now() - startedAt,
      },
      `[FarcasterClient] ${op} ok`
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elizaLogger.warn(
      {
        sdk: "neynar",
        op,
        ...context,
        durationMs: Date.now() - startedAt,
        error: message,
      },
      `[FarcasterClient] ${op} failed`
    );
    throw error;
  }
}

const castCache: LRUCache<string, NeynarCast> = new LRUCache({
  max: DEFAULT_CAST_CACHE_SIZE,
  ttl: DEFAULT_CAST_CACHE_TTL,
});

const profileCache: LRUCache<number, Profile> = new LRUCache({
  max: 1000,
  ttl: 1000 * 60 * 15,
});

export class FarcasterClient {
  private neynar: NeynarAPIClient;
  private signerUuid: string;

  constructor(opts: { neynar: NeynarAPIClient; signerUuid: string }) {
    this.neynar = opts.neynar;
    this.signerUuid = opts.signerUuid;
  }

  async sendCast({
    content,
    inReplyTo,
  }: {
    content: Content;
    inReplyTo?: CastId;
  }): Promise<NeynarCast[]> {
    const text = (content.text ?? "").trim();
    if (text.length === 0) {
      return [];
    }

    const chunks = splitPostContent(text);
    const sent: NeynarCast[] = [];

    for (const chunk of chunks) {
      const result = await this.publishCast(chunk, inReplyTo);
      sent.push(result);
    }
    return sent;
  }

  private async publishCast(cast: string, parentCastId?: CastId): Promise<NeynarCast> {
    try {
      const result = await logNeynarCall(
        "publishCast",
        { textLen: cast.length, parentHash: parentCastId?.hash ?? null },
        async () =>
          this.neynar.publishCast({
            signerUuid: this.signerUuid,
            text: cast,
            parent: parentCastId?.hash,
          })
      );
      if (result.success) {
        return this.getCast(result.cast.hash);
      }
      throw new Error(`[Farcaster] Error publishing [${cast}] parentCastId: [${parentCastId}]`);
    } catch (err) {
      if (isApiErrorResponse(err)) {
        elizaLogger.error(`Neynar error: ${JSON.stringify(err.response.data)}`);
        throw err.response.data;
      } else {
        throw err;
      }
    }
  }

  async getCast(castHash: string): Promise<NeynarCast> {
    const cachedCast = castCache.get(castHash);
    if (cachedCast) {
      return cachedCast;
    }

    const response = await logNeynarCall("lookupCastByHashOrUrl", { castHash }, async () =>
      this.neynar.lookupCastByHashOrUrl({
        identifier: castHash,
        type: "hash",
      })
    );

    castCache.set(castHash, response.cast);

    return response.cast;
  }

  /**
   * Get mentions for a FID.
   */
  async getMentions(request: FidRequest): Promise<NeynarCast[]> {
    const neynarMentionsResponse = await logNeynarCall(
      "fetchAllNotifications",
      { fid: request.fid, pageSize: request.pageSize },
      async () =>
        this.neynar.fetchAllNotifications({
          fid: request.fid,
          type: ["mentions", "replies"],
          limit: request.pageSize,
        })
    );
    const mentions: NeynarCast[] = [];

    for (const notification of neynarMentionsResponse.notifications) {
      const neynarCast = notification.cast;
      if (neynarCast) {
        mentions.push(neynarCast);
      }
    }

    return mentions;
  }

  async getProfile(fid: number): Promise<Profile> {
    if (profileCache.has(fid)) {
      return profileCache.get(fid) as Profile;
    }

    const result = await logNeynarCall("fetchBulkUsers", { fid }, async () =>
      this.neynar.fetchBulkUsers({ fids: [fid] })
    );
    if (result.users.length < 1) {
      throw new Error("Profile fetch failed");
    }

    const neynarUserProfile = result.users[0];

    const profile: Profile = {
      fid,
      name: "",
      username: "",
    };

    profile.name = neynarUserProfile.display_name ?? "";
    profile.username = neynarUserProfile.username;
    profile.bio = neynarUserProfile.profile.bio.text;
    profile.pfp = neynarUserProfile.pfp_url;

    profileCache.set(fid, profile);

    return profile;
  }

  async getTimeline(request: FidRequest): Promise<{
    timeline: Cast[];
    cursor?: string;
  }> {
    const timeline: Cast[] = [];

    const response = await logNeynarCall(
      "fetchCastsForUser",
      { fid: request.fid, pageSize: request.pageSize },
      async () =>
        this.neynar.fetchCastsForUser({
          fid: request.fid,
          limit: request.pageSize,
        })
    );

    for (const cast of response.casts) {
      castCache.set(cast.hash, cast);
      timeline.push(neynarCastToCast(cast));
    }

    const nextCursor = response.next?.cursor ?? undefined;

    return {
      timeline,
      cursor: nextCursor,
    };
  }

  clearCache(): void {
    profileCache.clear();
    castCache.clear();
  }

  async publishReaction(params: {
    reactionType: "like" | "recast";
    target: string;
  }): Promise<{ success: boolean }> {
    try {
      const result = await logNeynarCall(
        "publishReaction",
        { reactionType: params.reactionType, target: params.target },
        async () =>
          this.neynar.publishReaction({
            signerUuid: this.signerUuid,
            reactionType: params.reactionType,
            target: params.target,
          })
      );

      return { success: result.success ?? false };
    } catch (err) {
      if (isApiErrorResponse(err)) {
        elizaLogger.error(`Neynar error publishing reaction: ${JSON.stringify(err.response.data)}`);
        throw err.response.data;
      }
      throw err;
    }
  }

  async deleteReaction(params: {
    reactionType: "like" | "recast";
    target: string;
  }): Promise<{ success: boolean }> {
    try {
      const result = await logNeynarCall(
        "deleteReaction",
        { reactionType: params.reactionType, target: params.target },
        async () =>
          this.neynar.deleteReaction({
            signerUuid: this.signerUuid,
            reactionType: params.reactionType,
            target: params.target,
          })
      );

      return { success: result.success ?? false };
    } catch (err) {
      if (isApiErrorResponse(err)) {
        elizaLogger.error(`Neynar error deleting reaction: ${JSON.stringify(err.response.data)}`);
        throw err.response.data;
      }
      throw err;
    }
  }
}
