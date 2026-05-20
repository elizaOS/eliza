import { createHash } from 'node:crypto';
import { db, eq, users } from '@babylon/db';
import { generateSnowflakeId } from '@babylon/shared';

const PLAYWRIGHT_DEV_USERNAME = 'synpress-dev-trader';
const PLAYWRIGHT_DEV_DISPLAY_NAME = 'Synpress Dev Trader';
const _DEV_ADMIN_USER_ID = 'dev-admin-local';
const DEFAULT_WALLET_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

type BrowserDevAuthSession = {
  userId: string;
  accessToken: string;
  adminToken: string;
  displayName: string;
  walletAddress: string;
};

function createPlaywrightTestPrivyToken(userId: string): string {
  return `did:privy:test-${userId}`;
}

function deriveSecret(seed: string, purpose: string): string {
  const hash = createHash('sha256')
    .update(`babylon-dev:${seed}:${purpose}`)
    .digest('hex');
  return `dev_${purpose}_${hash.substring(0, 32)}`;
}

async function ensureSynpressDevUser(): Promise<BrowserDevAuthSession> {
  const [existingUser] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
    })
    .from(users)
    .where(eq(users.username, PLAYWRIGHT_DEV_USERNAME))
    .limit(1);

  const userId = existingUser?.id ?? (await generateSnowflakeId());
  const displayName =
    existingUser?.displayName?.trim() || PLAYWRIGHT_DEV_DISPLAY_NAME;
  const now = new Date();
  const userValues = {
    username: PLAYWRIGHT_DEV_USERNAME,
    displayName,
    bio: 'Local Synpress trading account',
    walletAddress: DEFAULT_WALLET_ADDRESS,
    isAdmin: true,
    profileComplete: true,
    hasUsername: true,
    hasBio: true,
    profileSetupCompletedAt: now,
    tosAccepted: true,
    tosAcceptedAt: now,
    privacyPolicyAccepted: true,
    privacyPolicyAcceptedAt: now,
    gameGuideCompletedAt: now,
    updatedAt: now,
  } as const;

  if (existingUser) {
    await db.update(users).set(userValues).where(eq(users.id, userId));
  } else {
    await db.insert(users).values({
      id: userId,
      ...userValues,
      privyId: createPlaywrightTestPrivyToken(userId),
    });
  }

  const hostname = process.env.HOSTNAME || 'localhost';
  return {
    userId,
    accessToken: createPlaywrightTestPrivyToken(userId),
    adminToken: deriveSecret(hostname, 'admin'),
    displayName,
    walletAddress: DEFAULT_WALLET_ADDRESS,
  };
}

const session = await ensureSynpressDevUser();
process.stdout.write(`${JSON.stringify(session)}\n`);
