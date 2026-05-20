import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PRIVY_TOKEN_COOKIE_NAME = "privy-token";
const DEV_USER_ID_COOKIE_NAME = "feed-dev-user-id";
const DEV_ADMIN_TOKEN_COOKIE_NAME = "feed-dev-admin-token";
const PLAYWRIGHT_DEV_AUTH_STORAGE_KEY = "feed-playwright-dev-auth";

type BrowserDevAuthSession = {
  userId: string;
  accessToken: string;
  adminToken: string;
  displayName: string;
  walletAddress: string;
};

async function seedChromaDevAuthSession(): Promise<BrowserDevAuthSession> {
  const scriptPath = path.resolve(
    REPO_ROOT,
    "tools/chroma/scripts/ensure-dev-auth-session.ts",
  );

  return await new Promise<BrowserDevAuthSession>((resolve, reject) => {
    const child = spawn("bun", ["run", scriptPath], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `chroma dev auth seeding failed with exit code ${code ?? -1}`,
          ),
        );
        return;
      }

      const session = JSON.parse(stdout.trim()) as BrowserDevAuthSession;
      resolve(session);
    });
  });
}

export async function installSynpressDevAuth(
  page: Page,
  baseURL: string,
): Promise<BrowserDevAuthSession> {
  const session = await seedChromaDevAuthSession();

  await page.context().addCookies([
    {
      name: PRIVY_TOKEN_COOKIE_NAME,
      value: session.accessToken,
      url: baseURL,
      sameSite: "Lax",
    },
    {
      name: DEV_USER_ID_COOKIE_NAME,
      value: session.userId,
      url: baseURL,
      sameSite: "Lax",
    },
    {
      name: DEV_ADMIN_TOKEN_COOKIE_NAME,
      value: session.adminToken,
      url: baseURL,
      sameSite: "Lax",
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
    },
  );

  await page.goto(`${baseURL}/?dev=true`, { waitUntil: "domcontentloaded" });
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
    },
  );

  return session;
}
