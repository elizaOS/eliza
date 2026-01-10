export interface TestInteraction {
  type: 'RECAST' | 'REPLY' | 'LIKE';
  castId?: string;
  content?: string;
}

export interface TestCast {
  hash: string;
  text: string;
  username: string;
  fid: string;
  timestamp: number;
  threadHash: string;
  permanentUrl: string;
  photos: any[];
  hashtags: string[];
  mentions: string[];
  thread: any[];
  urls: string[];
  videos: any[];
}

export interface TestImage {
  id: string;
  text: string;
  description: string;
  source: string;
  url: string;
  title: string;
  contentType: string;
  alt_text: string;
}

export enum ServiceType {
  FARCASTER = 'farcaster',
}

export interface CastId {
  hash: string;
  fid: string;
}

export interface CastStats {
  recasts: number;
  replies: number;
  likes: number;
}

export interface Profile {
  fid: string;
  username: string;
  name: string;
  pfp: string;
}

export interface Cast {
  hash: string;
  authorFid: string;
  text: string;
  timestamp: Date;
  profile: Profile;
  stats: CastStats;
}

export interface FarcasterClient {
  client: {
    fetchProfile: (username: string) => Promise<Profile>;
    fetchUserCasts: (fid: string, limit: number) => Promise<Cast[]>;
    fetchFeed: (limit: number) => Promise<Cast[]>;
    fetchOwnCasts: (limit: number) => Promise<Cast[]>;
  };
  post: {
    postCast: (
      runtime: any,
      client: any,
      text: string,
      roomId: string,
      content: string,
      username: string,
      media?: any[]
    ) => Promise<void>;
    generateNewCast: () => Promise<void>;
  };
  interaction: {
    handleCast: (params: { cast: Cast; message: any; thread: any[] }) => Promise<void>;
  };
  publishCast: (
    text: string,
    parent?: CastId
  ) => Promise<{
    success: boolean;
    cast: {
      hash: string;
      author: { fid: string };
      text: string;
      timestamp: string;
      parent_hash?: string;
    };
  }>;
}
