/** Covers seeded Google grant admission, ledger metadata, and reset without live Google. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

const OWNER_EMAIL = "owner@example.test";
const OWNER_GRANT_ID = "mock-google-work-grant";
const OWNER_ACCESS_TOKEN = "mock-google-access-token-mock-google-work-grant";
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";

let activeMocks: StartedMocks | null = null;
const envSnapshot = {
  ELIZA_OAUTH_DIR: process.env.ELIZA_OAUTH_DIR,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
  HOME: process.env.HOME,
};
let tempRoot: string | null = null;

afterEach(async () => {
  if (activeMocks) {
    await activeMocks.stop();
    activeMocks = null;
  }
  restoreEnv();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function restoreEnv(): void {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isolateGrantHome(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "google-grant-auth-"));
  delete process.env.ELIZA_OAUTH_DIR;
  delete process.env.ELIZA_STATE_DIR;
  process.env.XDG_STATE_HOME = path.join(tempRoot, "xdg-state");
  process.env.ELIZA_NAMESPACE = "eliza-google-grant-test";
  process.env.HOME = path.join(tempRoot, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  return process.env.XDG_STATE_HOME;
}

function writeOwnerGrant(xdgStateHome: string): string {
  const dir = path.join(
    xdgStateHome,
    "eliza-google-grant-test",
    "credentials",
    "lifeops",
    "google",
    "agent",
    "owner",
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    dir,
    "local.mock-google-work-grant.mocked-tests.json",
  );
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        provider: "google",
        accessToken: OWNER_ACCESS_TOKEN,
        refreshToken: "mock-google-refresh-token-mock-google-work-grant",
        grantedScopes: [GMAIL_READONLY, CALENDAR_READONLY],
        grantId: OWNER_GRANT_ID,
        accountEmail: OWNER_EMAIL,
        gmailAccountId: "work",
      },
      null,
      2,
    ),
    { encoding: "utf-8", mode: 0o600 },
  );
  return filePath;
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function ownerAuthHeaders(): HeadersInit {
  return { Authorization: `Bearer ${OWNER_ACCESS_TOKEN}` };
}

function assertLedgerHasNoCredentialValues(
  requests: readonly Record<string, unknown>[],
): void {
  const serialized = JSON.stringify(requests);
  expect(serialized).not.toContain(OWNER_ACCESS_TOKEN);
  expect(serialized).not.toContain("mock-google-refresh-token");
}

describe("Google mock seeded-grant authorization", () => {
  it("keeps an XDG-seeded owner grant valid across Gmail, Calendar, unrelated traffic, and reset", async () => {
    const xdg = isolateGrantHome();
    writeOwnerGrant(xdg);
    activeMocks = await startMocks({ envs: ["google"] });
    const baseUrl = activeMocks.baseUrls.google;

    const gmailBefore = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages`,
      { headers: ownerAuthHeaders() },
    );
    expect(gmailBefore.response.status).toBe(200);
    expect(Array.isArray(gmailBefore.body.messages)).toBe(true);
    expect((gmailBefore.body.messages as unknown[]).length).toBeGreaterThan(0);

    const calendarBefore = await jsonRequest(
      `${baseUrl}/calendar/v3/users/me/calendarList`,
      { headers: ownerAuthHeaders() },
    );
    expect(calendarBefore.response.status).toBe(200);
    const calendarItems = calendarBefore.body.items;
    expect(Array.isArray(calendarItems)).toBe(true);
    expect((calendarItems as unknown[]).length).toBeGreaterThan(0);

    const unknown = await jsonRequest(`${baseUrl}/gmail/v1/users/me/messages`, {
      headers: { Authorization: "Bearer unknown-or-expired-token" },
    });
    expect(unknown.response.status).toBe(401);

    const reset = await jsonRequest(`${baseUrl}/__mock/google/reset`, {
      method: "POST",
    });
    expect(reset.response.status).toBe(200);
    expect(reset.body.ok).toBe(true);
    expect(typeof reset.body.resetGeneration).toBe("number");

    const gmailAfter = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages`,
      { headers: ownerAuthHeaders() },
    );
    expect(gmailAfter.response.status).toBe(200);
    expect(Array.isArray(gmailAfter.body.messages)).toBe(true);
    expect((gmailAfter.body.messages as unknown[]).length).toBeGreaterThan(0);

    const ledger = await jsonRequest(`${baseUrl}/__mock/requests`);
    expect(ledger.response.status).toBe(200);
    const requests = ledger.body.requests as Array<Record<string, unknown>>;
    expect(Array.isArray(requests)).toBe(true);
    assertLedgerHasNoCredentialValues(requests);

    const googleAuthEntries = requests
      .map((entry) => ({
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        googleAuth: entry.googleAuth as Record<string, unknown> | undefined,
      }))
      .filter((entry) => entry.googleAuth);

    const admitted = googleAuthEntries.filter(
      (entry) => entry.googleAuth?.authStatus === "admitted",
    );
    expect(admitted.length).toBeGreaterThanOrEqual(3);
    expect(admitted[0]?.googleAuth).toEqual(
      expect.objectContaining({
        action: "auth",
        admittedAccountId: "work",
        admittedAccountEmail: OWNER_EMAIL,
        admittedGrantId: OWNER_GRANT_ID,
      }),
    );
    const admittedScopes = admitted[0]?.googleAuth?.requiredScopes;
    expect(Array.isArray(admittedScopes)).toBe(true);
    expect(admittedScopes?.length ?? 0).toBeGreaterThan(0);

    const rejected = googleAuthEntries.filter(
      (entry) => entry.googleAuth?.authStatus === "rejected",
    );
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/gmail/v1/users/me/messages",
          googleAuth: expect.objectContaining({
            authStatus: "rejected",
            statusCode: 401,
          }),
        }),
      ]),
    );

    const resetEntries = googleAuthEntries.filter(
      (entry) => entry.googleAuth?.authStatus === "reset",
    );
    expect(resetEntries).toHaveLength(1);
    expect(resetEntries[0]?.path).toBe("/__mock/google/reset");

    const paths = googleAuthEntries.map(
      (entry) => `${entry.method} ${entry.path}`,
    );
    expect(paths.indexOf("GET /gmail/v1/users/me/messages")).toBeLessThan(
      paths.indexOf("GET /calendar/v3/users/me/calendarList"),
    );
    expect(paths.indexOf("POST /__mock/google/reset")).toBeGreaterThan(
      paths.indexOf("GET /calendar/v3/users/me/calendarList"),
    );
  });

  it("admits a grant written after the mock starts (runtime seed order)", async () => {
    const xdg = isolateGrantHome();
    activeMocks = await startMocks({ envs: ["google"] });
    const baseUrl = activeMocks.baseUrls.google;

    const beforeSeed = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages`,
      { headers: ownerAuthHeaders() },
    );
    expect(beforeSeed.response.status).toBe(401);

    writeOwnerGrant(xdg);

    const afterSeed = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages`,
      { headers: ownerAuthHeaders() },
    );
    expect(afterSeed.response.status).toBe(200);
    expect(Array.isArray(afterSeed.body.messages)).toBe(true);
  });
});
