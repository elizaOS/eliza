/**
 * The mobile sign-in reply says "account created" (`stewardAccountCreated`) when
 * the Steward session made the organization. A retry of the same sign-in finds the
 * account the first request made, and must get the same answer.
 */
import { afterEach, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const ISSUED_AT = Math.floor(Date.parse("2026-10-17T12:00:00Z") / 1000);
const stewardClient = await import("./steward-client");
const { getCurrentUserForStewardToken } = await import("./workers-hono-auth");
const { usersService } = await import("../services/users");
type StewardUser = NonNullable<Awaited<ReturnType<typeof usersService.getByStewardId>>>;

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function sessionIssuedAt(issuedAt: number): void {
  spies.push(
    spyOn(stewardClient, "verifyStewardTokenCached").mockResolvedValue({
      userId: "steward-a",
      issuedAt,
      expiration: ISSUED_AT + 3600,
    }),
  );
}

function accountWithOrganizationCreatedAt(createdAt: Date | string, issuedAt = ISSUED_AT): void {
  sessionIssuedAt(issuedAt);
  const user = {
    id: "00000000-0000-4000-8000-0000000000a1",
    steward_user_id: "steward-a",
    organization_id: "00000000-0000-4000-8000-0000000000b1",
    role: "owner",
    is_active: true,
    is_anonymous: false,
    created_at: new Date(createdAt),
    organization: {
      id: "00000000-0000-4000-8000-0000000000b1",
      name: "A",
      is_active: true,
      created_at: createdAt,
    },
  } as unknown as StewardUser;
  spies.push(spyOn(usersService, "getByStewardId").mockResolvedValue(user));
}

/** One request: what the connect route reads after authentication. */
async function signInSaysCreated(): Promise<boolean> {
  const values = new Map<string, unknown>();
  const c = {
    env: {},
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  } as unknown as Parameters<typeof getCurrentUserForStewardToken>[0];
  expect(await getCurrentUserForStewardToken(c, "steward-session")).not.toBeNull();
  return c.get("stewardAccountCreated") === true;
}

test("every retry of a sign-in whose session made the organization says created", async () => {
  // The first request made the account; each retry finds it already there.
  accountWithOrganizationCreatedAt(new Date((ISSUED_AT + 2) * 1000));
  expect(await signInSaysCreated()).toBe(true);
  expect(await signInSaysCreated()).toBe(true);
});

test("a cached account (dates as text) gives the same answer", async () => {
  accountWithOrganizationCreatedAt(new Date((ISSUED_AT + 2) * 1000).toISOString());
  expect(await signInSaysCreated()).toBe(true);
});

test("a sign-in to an account made before the session says existing", async () => {
  accountWithOrganizationCreatedAt(new Date((ISSUED_AT - 2 * 24 * 3600) * 1000));
  expect(await signInSaysCreated()).toBe(false);
});

test("a session without an issue time never says created", async () => {
  accountWithOrganizationCreatedAt(new Date((ISSUED_AT + 2) * 1000), 0);
  expect(await signInSaysCreated()).toBe(false);
});
