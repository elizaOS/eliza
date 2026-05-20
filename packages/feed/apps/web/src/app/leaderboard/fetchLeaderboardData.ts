import type { LeaderboardMetric, LeaderboardScope } from '@feed/shared';

export interface LeaderboardUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  balance: number;
  lifetimePnL: number;
  capitalBase?: number;
  effectiveCapitalBase?: number;
  tradingReturn?: number;
  createdAt: Date;
  rank: number;
  isAgent?: boolean;
  managedBy?: string | null;
  nftTokenId?: number | null;
  teamReputationPoints?: number;
  userReputationPoints?: number;
  agentReputationPoints?: number;
  teamLifetimePnL?: number;
  userLifetimePnL?: number;
  agentLifetimePnL?: number;
  teamCapitalBase?: number;
  teamEffectiveCapitalBase?: number;
  teamTradingReturn?: number;
  agentCount?: number;
}

export interface CurrentUserPosition {
  rank: number;
  page: number;
  entry: LeaderboardUser;
}

export interface LeaderboardData {
  leaderboard: LeaderboardUser[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
  leaderboardType: LeaderboardScope;
  leaderboardMetric: LeaderboardMetric;
  currentUser: CurrentUserPosition | null;
  followingUserIds: string[];
  followingUserIdsResolved: boolean;
  generatedAt?: string;
}

export class LeaderboardFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'LeaderboardFetchError';
  }
}

export type FetchLeaderboardOptions = {
  currentPage: number;
  pageSize: number;
  selectedMetric: LeaderboardMetric;
  selectedScope: LeaderboardScope;
  userId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  retryDelayMs?: number;
  retries?: number;
};

function buildLeaderboardUrl({
  currentPage,
  pageSize,
  selectedMetric,
  selectedScope,
  userId,
}: Omit<FetchLeaderboardOptions, 'signal' | 'retryDelayMs' | 'retries'>) {
  const searchParams = new URLSearchParams({
    metric: selectedMetric,
    type: selectedScope,
    page: String(currentPage),
    pageSize: String(pageSize),
  });

  if (userId) {
    searchParams.set('userId', userId);
  }

  return `/api/leaderboard?${searchParams.toString()}`;
}

function isRetryableLeaderboardError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }

  if (error instanceof TypeError) {
    return error.message.toLowerCase().includes('fetch');
  }

  if (error instanceof LeaderboardFetchError && error.status !== undefined) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('load failed') ||
      message.includes('network')
    );
  }

  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function fetchLeaderboardData({
  currentPage,
  pageSize,
  selectedMetric,
  selectedScope,
  userId,
  authToken,
  signal,
  retryDelayMs = 1000,
  retries = 2,
}: FetchLeaderboardOptions): Promise<LeaderboardData> {
  const url = buildLeaderboardUrl({
    currentPage,
    pageSize,
    selectedMetric,
    selectedScope,
    userId,
  });

  const headers: HeadersInit | undefined = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { signal, headers });

      if (!response.ok) {
        throw new LeaderboardFetchError(
          `Failed to fetch leaderboard: ${response.status}`,
          response.status
        );
      }

      return (await response.json()) as LeaderboardData;
    } catch (error) {
      if (!isRetryableLeaderboardError(error) || attempt === retries) {
        throw error;
      }

      await sleep(retryDelayMs, signal);
    }
  }

  throw new LeaderboardFetchError('Failed to fetch leaderboard');
}
