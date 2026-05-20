import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticate = mock();
const mockEnsureOfflineWalletReady = mock();
const mockGetHashedClientIp = mock();
const mockIsReferralCodeAvailableForUser = mock();
const mockNotifyNewAccount = mock();
const mockTrackServerEvent = mock();
const mockGetOrCreateReferralCode = mock();
const mockAwardReferralSignup = mock();
const mockAwardPoints = mock();
const mockAwardFarcasterLink = mock();
const mockAwardTwitterLink = mock();
const mockAwardWalletConnect = mock();
const mockAwardProfileCompletion = mock();
const mockAwardWelcomeBonus = mock();
const mockWithRetry = mock();
const mockWithTransaction = mock();
const mockInvalidateUserIdentifierCaches = mock(async () => undefined);

const mockOnboardingProfileSchema = {
  extend: () => ({
    parse: (body: Record<string, unknown>) => body,
  }),
};

class MockNextRequest {
  headers: Headers;
  #body: string;

  constructor(
    _url: string,
    init: {
      body?: string;
      headers?: Record<string, string>;
      method?: string;
    } = {}
  ) {
    this.headers = new Headers(init.headers);
    this.#body = init.body ?? '{}';
  }

  async json() {
    return JSON.parse(this.#body);
  }
}

class MockConflictError extends Error {}
class MockInternalServerError extends Error {}

const _actualNextServer = await import('next/server');
mock.module('next/server', () => ({
  ..._actualNextServer,
}));

const _actualZod = await import('zod');
mock.module('zod', () => ({
  ..._actualZod,
}));

const _actualApi = await import('@babylon/api');
mock.module('@babylon/api', () => ({
  ..._actualApi,
  authenticate: mockAuthenticate,
  cachedDb: {
    invalidateUserIdentifierCaches: mockInvalidateUserIdentifierCaches,
  },
  ConflictError: MockConflictError,
  ensureOfflineWalletReady: mockEnsureOfflineWalletReady,
  getHashedClientIp: mockGetHashedClientIp,
  getOrCreateReferralCode: mockGetOrCreateReferralCode,
  getPrivyClient: mock(() => ({
    getUserFromIdToken: mock(),
  })),
  InternalServerError: MockInternalServerError,
  isReferralCodeAvailableForUser: mockIsReferralCodeAvailableForUser,
  notifyNewAccount: mockNotifyNewAccount,
  ReputationService: {
    awardReferralSignup: mockAwardReferralSignup,
    awardReputation: mockAwardPoints,
    awardPoints: mockAwardPoints,
    awardFarcasterLink: mockAwardFarcasterLink,
    awardTwitterLink: mockAwardTwitterLink,
    awardWalletConnect: mockAwardWalletConnect,
    awardProfileCompletion: mockAwardProfileCompletion,
  },
  PointsService: {
    awardReferralSignup: mockAwardReferralSignup,
    awardPoints: mockAwardPoints,
    awardFarcasterLink: mockAwardFarcasterLink,
    awardTwitterLink: mockAwardTwitterLink,
    awardWalletConnect: mockAwardWalletConnect,
    awardProfileCompletion: mockAwardProfileCompletion,
  },
  TradingBalanceFundingService: {
    awardWelcomeBonus: mockAwardWelcomeBonus,
  },
  successResponse: (data: unknown) =>
    Response.json({
      success: true,
      ...(typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {}),
    }),
  withErrorHandling: (
    handler: (request: MockNextRequest) => Promise<Response>
  ) => handler,
}));

const _actualDb = await import('@babylon/db');
mock.module('@babylon/db', () => ({
  ..._actualDb,
  and: (...conditions: unknown[]) => conditions,
  balanceTransactions: { id: 'balanceTransactions.id' },
  db: {
    select: mock(() => []),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve([])),
        returning: mock(() => Promise.resolve([])),
      })),
      where: mock(() => Promise.resolve([])),
    })),
    insert: mock(() => ({
      values: mock(() => Promise.resolve([])),
    })),
  },
  eq: (left: unknown, right: unknown) => ({ left, right }),
  follows: { id: 'follows.id' },
  isRetryableError: mock(() => false),
  ne: (left: unknown, right: unknown) => ({ left, right }),
  referrals: { id: 'referrals.id' },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  toDatabaseErrorType: mock((error: unknown) => error),
  users: {
    id: 'users.id',
    walletAddress: 'users.walletAddress',
    username: 'users.username',
  },
  withRetry: mockWithRetry,
  withTransaction: mockWithTransaction,
}));

const _actualEngine = await import('@babylon/engine');
(
  _actualEngine.UserAlphaGroupAssignmentService as unknown as Record<
    string,
    unknown
  >
).assignDefaultGroups = mock(async () => ({
  groupsAssigned: 0,
  assignments: [],
  errors: [],
}));
mock.module('@babylon/engine', () => ({
  ..._actualEngine,
}));

const _actualShared = await import('@babylon/shared');
mock.module('@babylon/shared', () => ({
  ..._actualShared,
  checkForAdminEmail: mock(() => ({
    adminEmail: null,
    allVerifiedEmails: [],
  })),
  generateSnowflakeId: mock(async () => 'generated-id'),
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
  OnboardingProfileSchema: mockOnboardingProfileSchema,
  POINTS: {
    ..._actualShared.POINTS,
    INITIAL_SIGNUP: 1000,
    REFERRAL_BONUS: 100,
  },
  toISO: (val: Date | string) =>
    val instanceof Date ? val.toISOString() : new Date(val).toISOString(),
  toISOOrNull: (val: Date | string | null | undefined) =>
    val == null
      ? null
      : val instanceof Date
        ? val.toISOString()
        : new Date(val).toISOString(),
}));

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: mockTrackServerEvent,
}));

const { POST } = await import(
  '../../../apps/web/src/app/api/users/signup/route'
);

describe('signup route referral code handling', () => {
  beforeEach(() => {
    mockAuthenticate.mockReset();
    mockEnsureOfflineWalletReady.mockReset();
    mockGetHashedClientIp.mockReset();
    mockIsReferralCodeAvailableForUser.mockReset();
    mockNotifyNewAccount.mockReset();
    mockTrackServerEvent.mockReset();
    mockGetOrCreateReferralCode.mockReset();
    mockAwardReferralSignup.mockReset();
    mockAwardPoints.mockReset();
    mockAwardFarcasterLink.mockReset();
    mockAwardTwitterLink.mockReset();
    mockAwardWalletConnect.mockReset();
    mockAwardProfileCompletion.mockReset();
    mockAwardWelcomeBonus.mockReset();
    mockWithRetry.mockReset();
    mockWithTransaction.mockReset();
    mockInvalidateUserIdentifierCaches.mockReset();

    mockAuthenticate.mockResolvedValue({
      userId: 'user_1',
      dbUserId: 'user_1',
      privyId: 'did:privy:user_1',
      walletAddress: null,
    });
    mockEnsureOfflineWalletReady.mockResolvedValue({
      walletAddress: null,
    });
    mockGetHashedClientIp.mockReturnValue(null);
    mockIsReferralCodeAvailableForUser.mockResolvedValue(true);
    mockNotifyNewAccount.mockResolvedValue(undefined);
    mockAwardWelcomeBonus.mockResolvedValue({
      success: true,
      balanceDelta: 1000,
      newBalance: 1000,
      alreadyProcessed: false,
      transactionId: 'funding-tx-1',
    });
    mockTrackServerEvent.mockResolvedValue(undefined);
    mockAwardReferralSignup.mockResolvedValue({
      success: false,
      pointsAwarded: 0,
      error: 'not-applicable',
    });
    mockAwardPoints.mockResolvedValue({
      success: true,
      pointsAwarded: 0,
      newTotal: 0,
    });
    mockAwardFarcasterLink.mockResolvedValue({ pointsAwarded: 0 });
    mockAwardTwitterLink.mockResolvedValue({ pointsAwarded: 0 });
    mockAwardWalletConnect.mockResolvedValue({ pointsAwarded: 0 });
    mockAwardProfileCompletion.mockResolvedValue({ pointsAwarded: 0 });
    mockWithRetry.mockResolvedValue({
      user: {
        id: 'user_1',
        privyId: 'did:privy:user_1',
        username: 'alice',
        displayName: 'Alice',
        bio: '',
        profileImageUrl: null,
        coverImageUrl: null,
        walletAddress: null,
        profileComplete: true,
        hasUsername: true,
        hasBio: false,
        hasProfileImage: false,
        nftTokenId: null,
        referralCode: 'alice',
        referredBy: null,
        reputationPoints: 1000,
        pointsAwardedForProfile: true,
        hasFarcaster: false,
        hasTwitter: false,
        farcasterUsername: null,
        twitterUsername: null,
        createdAt: new Date('2026-03-20T20:11:55.000Z'),
        updatedAt: new Date('2026-03-20T20:11:55.000Z'),
      },
      referrerId: null,
      referralRecordId: null,
    });
    mockWithTransaction.mockResolvedValue(undefined);
  });

  it('returns success without a post-signup referral code regeneration call', async () => {
    const request = new MockNextRequest(
      'https://babylon.market/api/users/signup',
      {
        method: 'POST',
        body: JSON.stringify({
          username: 'alice',
          displayName: 'Alice',
          isWaitlist: true,
        }),
        headers: {
          'content-type': 'application/json',
        },
      }
    );

    const response = await POST(request as unknown as NextRequest);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user.referralCode).toBe('alice');
    expect(mockGetOrCreateReferralCode).not.toHaveBeenCalled();
    expect(mockInvalidateUserIdentifierCaches).toHaveBeenCalled();
    expect(mockNotifyNewAccount).toHaveBeenCalledWith('user_1');
    expect(mockTrackServerEvent).toHaveBeenCalledWith(
      'user_1',
      'signup_completed',
      expect.objectContaining({
        username: 'alice',
      })
    );
  });
});
