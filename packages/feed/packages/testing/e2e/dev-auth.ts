import { db, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import type { Page } from '@playwright/test';
import { createHash } from 'crypto';

const PLAYWRIGHT_DEV_USERNAME = 'playwright-dev-admin';
const PLAYWRIGHT_DEV_DISPLAY_NAME = 'Playwright Dev Admin';
const PRIVY_TOKEN_COOKIE_NAME = 'privy-token';
const DEV_USER_ID_COOKIE_NAME = 'feed-dev-user-id';
const DEV_ADMIN_TOKEN_COOKIE_NAME = 'feed-dev-admin-token';
export const PLAYWRIGHT_DEV_AUTH_STORAGE_KEY = 'feed-playwright-dev-auth';
const DEV_ADMIN_USER_ID = 'dev-admin-local';

export interface BrowserDevAuthSession {
  userId: string;
  accessToken: string;
  adminToken?: string;
  displayName?: string;
}

function createPlaywrightTestPrivyToken(userId: string): string {
  return `did:privy:test-${userId}`;
}

function deriveSecret(seed: string, purpose: string): string {
  const hash = createHash('sha256')
    .update(`feed-dev:${seed}:${purpose}`)
    .digest('hex');
  return `dev_${purpose}_${hash.substring(0, 32)}`;
}

function getLocalDevCredentials(): {
  adminUserId: string;
  devAdminToken: string;
} | null {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const seed = process.env.HOSTNAME || 'localhost';
  return {
    adminUserId: DEV_ADMIN_USER_ID,
    devAdminToken: deriveSecret(seed, 'admin'),
  };
}

async function ensurePlaywrightDevUser(): Promise<BrowserDevAuthSession> {
  const creds = getLocalDevCredentials();
  if (!creds) {
    throw new Error(
      'Development credentials are unavailable. Local E2E auth requires development mode.'
    );
  }

  const [existingUser] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
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
    bio: 'Local Playwright admin account',
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
      privyId: `did:privy:test-${userId}`,
    });
  }

  return {
    userId,
    accessToken: createPlaywrightTestPrivyToken(userId),
    adminToken: creds.devAdminToken,
    displayName,
  };
}

export async function installPlaywrightDevAuth(
  page: Page,
  baseURL: string
): Promise<BrowserDevAuthSession> {
  const session = await ensurePlaywrightDevUser();

  await page.context().addCookies([
    {
      name: PRIVY_TOKEN_COOKIE_NAME,
      value: session.accessToken,
      url: baseURL,
      sameSite: 'Lax',
    },
    {
      name: DEV_USER_ID_COOKIE_NAME,
      value: session.userId,
      url: baseURL,
      sameSite: 'Lax',
    },
    {
      name: DEV_ADMIN_TOKEN_COOKIE_NAME,
      value: session.adminToken ?? '',
      url: baseURL,
      sameSite: 'Lax',
    },
  ]);

  await page.addInitScript(
    ({ storageKey, authSession }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(authSession));
      (
        window as Window & { __privyAccessToken?: string | null }
      ).__privyAccessToken = authSession.accessToken;
    },
    {
      storageKey: PLAYWRIGHT_DEV_AUTH_STORAGE_KEY,
      authSession: session,
    }
  );

  await page.goto(`${baseURL}/?dev=true`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ storageKey, authSession }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(authSession));
      (
        window as Window & { __privyAccessToken?: string | null }
      ).__privyAccessToken = authSession.accessToken;
    },
    {
      storageKey: PLAYWRIGHT_DEV_AUTH_STORAGE_KEY,
      authSession: session,
    }
  );

  return session;
}
