import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import { type NeynarAPIClient, isApiErrorResponse } from '@neynar/nodejs-sdk';
import type { NeynarCastResponse, Cast, Profile, FidRequest, CastId } from './common/types';
import type { FarcasterConfig } from './common/types';
import { castCacheKey, neynarCastToCast, profileCacheKey } from './common/utils';
export class FarcasterClient {
  private runtime: IAgentRuntime;
  private neynar: NeynarAPIClient;
  private signerUuid: string;
  private cache: Map<string, any>;
  private farcasterConfig: FarcasterConfig;

  constructor(opts: {
    runtime: IAgentRuntime;
    url: string;
    ssl: boolean;
    neynar: NeynarAPIClient;
    signerUuid: string;
    cache: Map<string, any>;
    farcasterConfig: FarcasterConfig;
  }) {
    this.cache = opts.cache;
    this.runtime = opts.runtime;
    this.neynar = opts.neynar;
    this.signerUuid = opts.signerUuid;
    this.farcasterConfig = opts.farcasterConfig;
  }

  async publishCast(
    cast: string,
    parentCastId: CastId | undefined,
    // eslint-disable-next-line
    retryTimes?: number
  ): Promise<NeynarCastResponse | undefined> {
    try {
      const result = await this.neynar.publishCast({
        signerUuid: this.signerUuid,
        text: cast,
        parent: parentCastId?.hash,
      });
      if (result.success) {
        return {
          hash: result.cast.hash,
          authorFid: result.cast.author.fid,
          text: result.cast.text,
        };
      }
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

  async getCast(castHash: string): Promise<Cast> {
    const castKey = castCacheKey(castHash);

    if (this.cache.has(castKey)) {
      return this.cache.get(castKey);
    }

    const response = await this.neynar.lookupCastByHashOrWarpcastUrl({
      identifier: castHash,
      type: 'hash',
    });

    const neynarCast = response.cast;
    const cast = neynarCastToCast(neynarCast);

    this.cache.set(castKey, cast);

    return cast;
  }

  async getCastsByFid(request: FidRequest): Promise<Cast[]> {
    const timeline: Cast[] = [];

    const response = await this.neynar.fetchCastsForUser({
      fid: request.fid,
      limit: request.pageSize,
    });
    response.casts.map((cast) => {
      const castKey = castCacheKey(cast.hash);
      this.cache.set(castKey, neynarCastToCast(cast));
      timeline.push(this.cache.get(castKey));
    });

    return timeline;
  }

  async getMentions(request: FidRequest): Promise<Cast[]> {
    const neynarMentionsResponse = await this.neynar.fetchAllNotifications({
      fid: request.fid,
      type: ['mentions', 'replies'],
      limit: request.pageSize,
    });
    const mentions: Cast[] = [];

    for (const notification of neynarMentionsResponse.notifications) {
      const neynarCast = notification.cast;
      if (neynarCast) {
        const cast = neynarCastToCast(neynarCast);
        mentions.push(cast);
        this.cache.set(castCacheKey(cast.hash), cast);
      }
    }

    return mentions;
  }

  async getProfile(fid: number): Promise<Profile> {
    const profileKey = profileCacheKey(fid);
    if (this.cache.has(profileKey)) {
      return this.cache.get(profileKey) as Profile;
    }

    const result = await this.neynar.fetchBulkUsers({ fids: [fid] });
    if (!result.users || result.users.length < 1) {
      elizaLogger.error('Error fetching user by fid');

      throw 'getProfile ERROR';
    }

    const neynarUserProfile = result.users[0];

    const profile: Profile = {
      fid,
      name: '',
      username: '',
    };

    /*
        const userDataBodyType = {
            1: "pfp",
            2: "name",
            3: "bio",
            5: "url",
            6: "username",
            // 7: "location",
            // 8: "twitter",
            // 9: "github",
        } as const;
        */

    profile.name = neynarUserProfile.display_name!;
    profile.username = neynarUserProfile.username;
    profile.bio = neynarUserProfile.profile.bio.text;
    profile.pfp = neynarUserProfile.pfp_url;

    this.cache.set(profileKey, profile);

    return profile;
  }

  async getTimeline(request: FidRequest): Promise<{
    timeline: Cast[];
    nextPageToken?: Uint8Array | undefined;
  }> {
    const timeline: Cast[] = [];

    const results = await this.getCastsByFid(request);

    for (const cast of results) {
      this.cache.set(`farcaster/cast/${cast.hash}`, cast);
      timeline.push(cast);
    }

    return {
      timeline,
      //TODO implement paging
      //nextPageToken: results.nextPageToken,
    };
  }
}
