/**
 * The DoorDash session id in the cache is the only handle on the user's
 * logged-in hosted browser. A cache read that fails must not look like
 * "no session": that would open a fresh browser, overwrite the stored id and
 * orphan the session the user signed in to.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";

const fixtureEnvironment = { CACHE_ENABLED: "true", CACHE_BACKEND: "memory" };
const previousEnvironment = Object.fromEntries(
  Object.keys(fixtureEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, fixtureEnvironment);

const created: string[] = [];
const deleted: string[] = [];
const liveSessions = new Set<string>();
mock.module("./doordash-browser-run", () => ({
  async createDoorDashBrowserSession() {
    const id = `browser-${created.length + 1}`;
    created.push(id);
    liveSessions.add(id);
    return { id, interactiveLiveViewUrl: `https://live.example/${id}` };
  },
  async getDoorDashBrowserSession(id: string) {
    if (!liveSessions.has(id)) throw new Error("session expired");
    return { id, interactiveLiveViewUrl: `https://live.example/${id}` };
  },
  async deleteDoorDashBrowserSession(id: string) {
    deleted.push(id);
    liveSessions.delete(id);
  },
  async executeDoorDashBrowserOperation() {
    return { loggedIn: true };
  },
}));

type Managed = typeof import("./doordash-managed");
type CacheModule = typeof import("../cache/client");
let managed: Managed;
let cache: CacheModule["cache"];

const auth = { organizationId: "org-1", userId: "user-1", requestSource: "mcp" as const };
const args = { conversationId: "conv-1" };

beforeAll(async () => {
  managed = await import("./doordash-managed");
  ({ cache } = await import("../cache/client"));
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a failed session lookup does not replace the user's logged-in browser session", async () => {
  await managed.callManagedDoorDashTool("doordash_auth_check", args, auth);
  const key = managed.getManagedDoorDashSessionKey({ ...auth, conversationId: "conv-1" });
  expect(created).toEqual(["browser-1"]);
  expect(await cache.get<string>(key)).toBe("browser-1");

  // The next call hits a cache read error (Redis blip, circuit open).
  const read = spyOn(cache, "getWithOutcome").mockResolvedValueOnce({
    kind: "error",
    backend: "memory",
  });
  try {
    await expect(
      managed.callManagedDoorDashTool("doordash_auth_check", args, auth),
    ).rejects.toThrow("DoorDash session storage is unavailable");
  } finally {
    read.mockRestore();
  }

  expect(created).toEqual(["browser-1"]);
  expect(await cache.get<string>(key)).toBe("browser-1");
  expect(liveSessions.has("browser-1")).toBe(true);

  // With the cache back, the same session is used again.
  await managed.callManagedDoorDashTool("doordash_auth_check", args, auth);
  expect(created).toEqual(["browser-1"]);
  expect(deleted).toEqual([]);
});
