"use client";

import { isRecord } from "@feed/shared";

const DEV_USER_ID_COOKIE_NAME = "feed-dev-user-id";
const DEV_ADMIN_TOKEN_COOKIE_NAME = "feed-dev-admin-token";
export const PLAYWRIGHT_DEV_AUTH_STORAGE_KEY = "feed-playwright-dev-auth";

export interface BrowserDevAuthSession {
  userId: string;
  accessToken: string;
  adminToken?: string;
  displayName?: string;
  email?: string;
  walletAddress?: string;
}

export function getBrowserDevAuthSession(): BrowserDevAuthSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(PLAYWRIGHT_DEV_AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const userId = typeof parsed.userId === "string" ? parsed.userId : null;
    const accessToken =
      typeof parsed.accessToken === "string" ? parsed.accessToken : null;

    if (!userId || !accessToken) {
      return null;
    }

    return {
      userId,
      accessToken,
      adminToken:
        typeof parsed.adminToken === "string" ? parsed.adminToken : undefined,
      displayName:
        typeof parsed.displayName === "string" ? parsed.displayName : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      walletAddress:
        typeof parsed.walletAddress === "string"
          ? parsed.walletAddress
          : undefined,
    };
  } catch {
    return null;
  }
}

export function clearBrowserDevAuthSession(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(PLAYWRIGHT_DEV_AUTH_STORAGE_KEY);
  document.cookie = `${DEV_USER_ID_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
  document.cookie = `${DEV_ADMIN_TOKEN_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
}
