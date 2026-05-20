interface MobileHeaderBalanceResponse {
  balance?: number | string | null;
}

interface MobileHeaderProfileResponse {
  user?: {
    reputationPoints?: number;
  } | null;
}

export interface MobileHeaderPointsSnapshot {
  available: number | null;
  reputationPoints: number | null;
}

interface FetchMobileHeaderPointsSnapshotOptions {
  userId: string;
  token: string;
  signal: AbortSignal;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  return false;
}

async function fetchJsonSafely<T>(
  input: RequestInfo,
  init: RequestInit,
  signal: AbortSignal
): Promise<T | null> {
  try {
    const response = await fetch(input, {
      ...init,
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw error;
    }

    return null;
  }
}

export async function fetchMobileHeaderPointsSnapshot({
  userId,
  token,
  signal,
}: FetchMobileHeaderPointsSnapshotOptions): Promise<MobileHeaderPointsSnapshot> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const encodedUserId = encodeURIComponent(userId);

  const [balanceData, profileData] = await Promise.all([
    fetchJsonSafely<MobileHeaderBalanceResponse>(
      `/api/users/${encodedUserId}/balance`,
      { headers },
      signal
    ),
    fetchJsonSafely<MobileHeaderProfileResponse>(
      `/api/users/${encodedUserId}/profile`,
      { headers },
      signal
    ),
  ]);

  return {
    available:
      balanceData?.balance === undefined || balanceData.balance === null
        ? null
        : Number(balanceData.balance),
    reputationPoints:
      typeof profileData?.user?.reputationPoints === 'number'
        ? profileData.user.reputationPoints
        : null,
  };
}
