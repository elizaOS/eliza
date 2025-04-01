import { Content, elizaLogger } from '@elizaos/core';
import { type NeynarAPIClient, isApiErrorResponse } from '@neynar/nodejs-sdk';
import { CastParamType } from '@neynar/nodejs-sdk/build/api/models/cast-param-type';
import { CastWithInteractions } from '@neynar/nodejs-sdk/build/api/models/cast-with-interactions';
import { LRUCache } from 'lru-cache';
import { DEFAULT_CAST_CACHE_SIZE, DEFAULT_CAST_CACHE_TTL } from './common/constants';
import type { Cast, CastId, FidRequest, Profile } from './common/types';
import { neynarCastToCast, splitPostContent } from './common/utils';

// add global cast cache
const castCache: LRUCache<string, CastWithInteractions> = new LRUCache({
  max: DEFAULT_CAST_CACHE_SIZE,
  ttl: DEFAULT_CAST_CACHE_TTL,
});

// add global profile cache
const profileCache: LRUCache<number, Profile> = new LRUCache({
  max: 1000,
  ttl: 1000 * 60 * 15, // 15 minutes
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
  }): Promise<CastWithInteractions[]> {
    const text = (content.text ?? '').trim();
    if (text.length === 0) {
      return [];
    }

    const chunks = splitPostContent(text);
    const sent: CastWithInteractions[] = [];

    for (const chunk of chunks) {
      const result = await this.publishCast(chunk, inReplyTo);
      sent.push(result);
    }
    return sent;
  }

  private async publishCast(cast: string, parentCastId?: CastId): Promise<CastWithInteractions> {
    try {
      const result = await this.neynar.publishCast({
        signerUuid: this.signerUuid,
        text: cast,
        parent: parentCastId?.hash,
      });
      if (result.success) {
        return this.getCast(result.cast.hash);
      }
      throw new Error(`[Farcaster] Error publishing [${cast}] parentCastId: [${parentCastId}]`);
    } catch (err) {
      if (isApiErrorResponse(err)) {
        elizaLogger.error('Neynar error: ', err.response.data);
        throw err.response.data;
      } else {
        elizaLogger.error('Error: ', err);
        throw err;
      }
    }
  }

  async getCast(castHash: string): Promise<CastWithInteractions> {
    const cachedCast = castCache.get(castHash);
    if (cachedCast) {
      return cachedCast;
    }

    const params = { identifier: castHash, type: CastParamType.Hash };
    const response = await this.neynar.lookupCastByHashOrWarpcastUrl(params);

    castCache.set(castHash, response.cast);

    return response.cast;
  }
  async getMentions(request: FidRequest): Promise<CastWithInteractions[]> {
    const neynarMentionsResponse = await this.neynar.fetchAllNotifications({
      fid: request.fid,
      type: ['mentions', 'replies'],
      limit: request.pageSize,
    });
    const mentions: CastWithInteractions[] = [];

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

    try {
      const result = await this.neynar.fetchBulkUsers({ fids: [fid] });
      if (!result.users || result.users.length < 1) {
        elizaLogger.error('Error fetching user by fid');
        throw new Error('Profile fetch failed');
      }

      const neynarUserProfile = result.users[0];

      const profile: Profile = {
        fid,
        name: '',
        username: '',
      };

      profile.name = neynarUserProfile.display_name!;
      profile.username = neynarUserProfile.username;
      profile.bio = neynarUserProfile.profile.bio.text;
      profile.pfp = neynarUserProfile.pfp_url;

      profileCache.set(fid, profile);

      return profile;
    } catch (error) {
      elizaLogger.error('Error fetching profile:', error);
      throw error;
    }
  }

  async getTimeline(request: FidRequest): Promise<{
    timeline: Cast[];
    cursor?: string;
  }> {
    const timeline: Cast[] = [];

    const response = await this.neynar.fetchCastsForUser({
      fid: request.fid,
      limit: request.pageSize,
    });

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
}
