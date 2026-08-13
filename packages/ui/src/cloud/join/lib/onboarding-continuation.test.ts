/** Verifies durable, fail-closed messaging→cloud continuation storage and transport. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeOnboardingContinuationCompletion,
  clearPendingOnboardingSession,
  clearPendingOnboardingSessionIfToken,
  completePendingOnboardingContinuation,
  type OnboardingContinuationTransport,
  observePendingOnboardingContinuationCompletion,
  observeRecentOnboardingContinuationCompletion,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./onboarding-continuation";

const STORAGE_KEY = "eliza.join.onboardingSession";
// Obviously-fake, low-entropy stand-ins for opaque continuation UUIDs
// (realistic random UUIDs here trip the gitleaks generic-api-key rule).
const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";
const OTHER_TOKEN = "bbbbbbbb-test-test-test-tokentoken02";

const INVALID_PREVIEW_RESPONSES: Array<[string, unknown]> = [
  ["missing success envelope", { data: {} }],
  [
    "Discord return URL",
    {
      success: true,
      data: {
        platform: "discord",
        platformUserId: "123",
        platformDisplayName: "Ada",
        returnUrl: "https://evil.example",
      },
    },
  ],
  ...[
    "sms:+1808?body=x",
    "sms:+1808#fragment",
    "sms:+1808%0aevil",
    "sms:+1 808 555 0123",
    "sms:+1808\n555",
    "https://evil.example",
  ].map((returnUrl): [string, unknown] => [
    `unsafe return URL ${JSON.stringify(returnUrl)}`,
    {
      success: true,
      data: {
        platform: "blooio",
        platformUserId: "+14155550123",
        platformDisplayName: "Shaw",
        returnUrl,
      },
    },
  ]),
];

type OperationMode = "normal" | "noop" | "throw" | "act-then-throw";

interface ControlledStorage {
  storage: Storage;
  behavior: {
    getThrows: boolean;
    getThrowsOnCalls: Set<number>;
    set: OperationMode;
    remove: OperationMode;
  };
  readRaw(): string | null;
}

function storedRecord(
  token = TOKEN,
  expiresAt = Date.now() + 60 * 60 * 1000,
  redemption?: "pending" | "committed",
): string {
  return JSON.stringify({ token, expiresAt, redemption });
}

function successfulRedemption(sessionId = TOKEN): Record<string, unknown> {
  return { success: true, data: { sessionId, requiresLogin: false } };
}

function controlledStorage(initial: string | null = null): ControlledStorage {
  const values = new Map<string, string>();
  if (initial !== null) values.set(STORAGE_KEY, initial);
  const behavior: ControlledStorage["behavior"] = {
    getThrows: false,
    getThrowsOnCalls: new Set(),
    set: "normal",
    remove: "normal",
  };
  let getCalls = 0;

  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => {
      getCalls += 1;
      if (behavior.getThrows || behavior.getThrowsOnCalls.has(getCalls)) {
        throw new Error("get blocked");
      }
      return values.get(key) ?? null;
    }),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      if (behavior.remove === "throw") throw new Error("remove blocked");
      if (behavior.remove !== "noop") values.delete(key);
      if (behavior.remove === "act-then-throw") {
        throw new Error("remove reported failure");
      }
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (behavior.set === "throw") throw new Error("set blocked");
      if (behavior.set !== "noop") values.set(key, value);
      if (behavior.set === "act-then-throw") {
        throw new Error("set reported failure");
      }
    }),
  };

  return {
    storage,
    behavior,
    readRaw: () => values.get(STORAGE_KEY) ?? null,
  };
}

function installStoragePair(
  session: ControlledStorage,
  local: ControlledStorage,
): void {
  vi.spyOn(window, "sessionStorage", "get").mockReturnValue(session.storage);
  vi.spyOn(window, "localStorage", "get").mockReturnValue(local.storage);
}

afterEach(() => {
  acknowledgeOnboardingContinuationCompletion(TOKEN);
  acknowledgeOnboardingContinuationCompletion(OTHER_TOKEN);
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("sanitizeOnboardingSessionToken", () => {
  it("accepts the opaque continuation shape", () => {
    expect(sanitizeOnboardingSessionToken(TOKEN)).toBe(TOKEN);
    expect(sanitizeOnboardingSessionToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it("rejects platform-scoped ids — only a trusted gateway may present those", () => {
    expect(
      sanitizeOnboardingSessionToken("platform:discord:999900000000000099"),
    ).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(sanitizeOnboardingSessionToken(null)).toBeNull();
    expect(sanitizeOnboardingSessionToken("")).toBeNull();
    expect(sanitizeOnboardingSessionToken("short")).toBeNull();
    expect(sanitizeOnboardingSessionToken("a".repeat(200))).toBeNull();
    expect(sanitizeOnboardingSessionToken("bad token with spaces")).toBeNull();
    expect(
      sanitizeOnboardingSessionToken("<script>alert(1)</script>"),
    ).toBeNull();
  });
});

describe("pending-token presence", () => {
  it("persists an exact record and survives repeated peeks", () => {
    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
  });

  it("rejects an invalid token without changing verified-empty storage", () => {
    expect(
      storePendingOnboardingSession("platform:discord:123456789012"),
    ).toEqual({ presence: "indeterminate" });
    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("refreshes a pending same-token URL record with exact readback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    const original = storedRecord(TOKEN, Date.now() + 5_000);
    const session = controlledStorage(original);
    const local = controlledStorage();
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(session.readRaw()).not.toBe(original);
    expect(JSON.parse(session.readRaw() ?? "{}")).toEqual({
      token: TOKEN,
      expiresAt: Date.now() + 60 * 60 * 1000,
      redemption: "pending",
    });
    expect(local.readRaw()).toBe(session.readRaw());
  });

  it("does not rewrite or renew an already-fresh same-token ingestion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    const session = controlledStorage();
    const local = controlledStorage();
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toMatchObject({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    const firstSession = session.readRaw();
    const firstLocal = local.readRaw();
    vi.advanceTimersByTime(1_000);
    expect(storePendingOnboardingSession(TOKEN)).toMatchObject({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });

    expect(session.readRaw()).toBe(firstSession);
    expect(local.readRaw()).toBe(firstLocal);
    expect(session.storage.setItem).toHaveBeenCalledTimes(1);
    expect(local.storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("preserves a committed same-token receipt without TTL renewal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    const original = storedRecord(TOKEN, Date.now() + 5_000, "committed");
    const session = controlledStorage(original);
    const local = controlledStorage();
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    expect(session.readRaw()).toBe(original);
    expect(local.readRaw()).toBeNull();
    expect(session.storage.setItem).not.toHaveBeenCalled();
    expect(local.storage.setItem).not.toHaveBeenCalled();
  });

  it("accepts one exact write when the other setter fails", () => {
    const session = controlledStorage();
    const local = controlledStorage();
    session.behavior.set = "throw";
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(session.readRaw()).toBeNull();
    expect(JSON.parse(local.readRaw() ?? "{}")).toMatchObject({ token: TOKEN });
  });

  it("accepts an exact readback even when a setter reports failure", () => {
    const session = controlledStorage();
    const local = controlledStorage();
    session.behavior.set = "act-then-throw";
    local.behavior.set = "throw";
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: TOKEN,
    });
  });

  it.each(["noop", "throw"] as const)(
    "keeps URL authority when both writes %s",
    (mode) => {
      const session = controlledStorage();
      const local = controlledStorage();
      session.behavior.set = mode;
      local.behavior.set = mode;
      installStoragePair(session, local);

      expect(storePendingOnboardingSession(TOKEN)).toEqual({
        presence: "indeterminate",
      });
      expect(session.readRaw()).toBeNull();
      expect(local.readRaw()).toBeNull();
    },
  );

  it("requires readable exact writeback", () => {
    const session = controlledStorage();
    const local = controlledStorage();
    session.behavior.getThrowsOnCalls.add(2);
    local.behavior.getThrowsOnCalls.add(2);
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "indeterminate",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: TOKEN,
    });
    expect(JSON.parse(local.readRaw() ?? "{}")).toMatchObject({ token: TOKEN });
  });

  it("coherently replaces an older pending token from a fresh URL", () => {
    const session = controlledStorage(storedRecord(OTHER_TOKEN));
    const local = controlledStorage();
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: TOKEN,
    });
    expect(JSON.parse(local.readRaw() ?? "{}")).toMatchObject({ token: TOKEN });
  });

  it("uses the fresh URL to resolve two conflicting pending records", () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(OTHER_TOKEN));
    installStoragePair(session, local);

    expect(peekPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: TOKEN,
    });
    expect(JSON.parse(local.readRaw() ?? "{}")).toMatchObject({ token: TOKEN });
  });

  it("retains URL authority when an older token cannot be replaced everywhere", () => {
    const session = controlledStorage(storedRecord(OTHER_TOKEN));
    const local = controlledStorage();
    session.behavior.set = "noop";
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "indeterminate",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: OTHER_TOKEN,
    });
    expect(JSON.parse(local.readRaw() ?? "{}")).toMatchObject({ token: TOKEN });
  });

  it("never replaces a different committed receipt", () => {
    const session = controlledStorage(
      storedRecord(OTHER_TOKEN, undefined, "committed"),
    );
    const local = controlledStorage();
    installStoragePair(session, local);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "indeterminate",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: OTHER_TOKEN,
      redemption: "committed",
    });
    expect(session.storage.setItem).not.toHaveBeenCalled();
    expect(local.storage.setItem).not.toHaveBeenCalled();
  });

  it("returns a readable valid token even when the other store is unreadable", () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage();
    local.behavior.getThrows = true;
    installStoragePair(session, local);

    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
  });

  it("is indeterminate when one accessor fails and the other is absent", () => {
    const local = controlledStorage();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("session storage blocked");
    });
    vi.spyOn(window, "localStorage", "get").mockReturnValue(local.storage);

    expect(peekPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
  });

  it("persists to a verified-empty peer when one accessor is unavailable", () => {
    const local = controlledStorage();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("session storage blocked");
    });
    vi.spyOn(window, "localStorage", "get").mockReturnValue(local.storage);

    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(JSON.parse(local.readRaw() ?? "{}")).toMatchObject({ token: TOKEN });
  });

  it("is indeterminate when one getter fails and the other is absent", () => {
    const session = controlledStorage();
    const local = controlledStorage();
    session.behavior.getThrows = true;
    installStoragePair(session, local);

    expect(peekPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
  });

  it("is indeterminate when both storage accessors are unavailable", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("session storage blocked");
    });
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("local storage blocked");
    });

    expect(peekPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
    expect(storePendingOnboardingSession(TOKEN)).toEqual({
      presence: "indeterminate",
    });
  });

  it.each([
    ["expired", storedRecord(TOKEN, Date.now() - 1)],
    ["malformed", "{not-json"],
    ["empty", ""],
    [
      "unknown redemption state",
      JSON.stringify({
        token: TOKEN,
        expiresAt: Date.now() + 60_000,
        redemption: "mystery",
      }),
    ],
  ])("cleans and verifies an %s record", (_label, value) => {
    const session = controlledStorage(value);
    const local = controlledStorage();
    installStoragePair(session, local);

    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
    expect(session.storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(session.readRaw()).toBeNull();
  });

  it.each(["noop", "throw"] as const)(
    "treats unverifiable malformed cleanup (%s) as indeterminate",
    (mode) => {
      const session = controlledStorage("");
      const local = controlledStorage();
      session.behavior.remove = mode;
      installStoragePair(session, local);

      expect(peekPendingOnboardingSession()).toEqual({
        presence: "indeterminate",
      });
    },
  );

  it("accepts a removal that throws only after readback proves absence", () => {
    const session = controlledStorage("{bad-json");
    const local = controlledStorage();
    session.behavior.remove = "act-then-throw";
    installStoragePair(session, local);

    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("expires and removes a stored token", () => {
    vi.useFakeTimers();
    storePendingOnboardingSession(TOKEN);
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);

    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("pending-token clearing", () => {
  it("proves both stores empty", () => {
    storePendingOnboardingSession(TOKEN);
    expect(clearPendingOnboardingSession()).toEqual({ presence: "absent" });
    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("reports a residual valid token when one remover is a no-op", () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(TOKEN));
    session.behavior.remove = "noop";
    installStoragePair(session, local);

    expect(clearPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
    expect(session.readRaw()).not.toBeNull();
    expect(local.readRaw()).toBeNull();
  });

  it("reports conflicting residual valid tokens as indeterminate", () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(OTHER_TOKEN));
    session.behavior.remove = "noop";
    local.behavior.remove = "noop";
    installStoragePair(session, local);

    expect(clearPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
  });

  it("accepts removals that throw only after both readbacks prove absence", () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(TOKEN));
    session.behavior.remove = "act-then-throw";
    local.behavior.remove = "act-then-throw";
    installStoragePair(session, local);

    expect(clearPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("is indeterminate when a removal leaves malformed residue", () => {
    const session = controlledStorage("");
    const local = controlledStorage();
    session.behavior.remove = "noop";
    installStoragePair(session, local);

    expect(clearPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
  });

  it("is indeterminate when post-removal readback fails", () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(TOKEN));
    session.behavior.getThrows = true;
    installStoragePair(session, local);

    expect(clearPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
  });

  it("is indeterminate when one accessor blocks verified clearing", () => {
    const local = controlledStorage(storedRecord(TOKEN));
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("session storage blocked");
    });
    vi.spyOn(window, "localStorage", "get").mockReturnValue(local.storage);

    expect(clearPendingOnboardingSession()).toEqual({
      presence: "indeterminate",
    });
    expect(local.readRaw()).toBeNull();
  });
});

describe("previewPendingOnboardingContinuation", () => {
  it("loads the trusted Discord identity without redeeming it", async () => {
    const get = vi.fn().mockResolvedValue({
      success: true,
      data: {
        platform: "discord",
        platformUserId: "1234567890",
        platformDisplayName: "attested-user",
        returnUrl: null,
      },
    });
    const preview = await previewPendingOnboardingContinuation(TOKEN, {
      get,
      post: vi.fn(),
    });
    expect(get).toHaveBeenCalledWith(
      `/api/eliza-app/onboarding/chat?sessionId=${encodeURIComponent(TOKEN)}`,
    );
    expect(preview.platformDisplayName).toBe("attested-user");
  });

  it("carries a trusted iMessage return deep link", async () => {
    const preview = await previewPendingOnboardingContinuation(TOKEN, {
      get: vi.fn().mockResolvedValue({
        success: true,
        data: {
          platform: "blooio",
          platformUserId: "+14155550123",
          platformDisplayName: "Shaw",
          returnUrl: "sms:+18087881821",
        },
      }),
      post: vi.fn(),
    });
    expect(preview).toMatchObject({
      platform: "blooio",
      returnUrl: "sms:+18087881821",
    });
  });

  it.each(INVALID_PREVIEW_RESPONSES)("rejects %s", async (_label, response) => {
    await expect(
      previewPendingOnboardingContinuation(TOKEN, {
        get: vi.fn().mockResolvedValue(response),
        post: vi.fn(),
      }),
    ).rejects.toThrow("Could not verify");
  });

  it("accepts a null phone return and a conservative SMS email target", async () => {
    for (const returnUrl of [null, "sms:ada@example.com"] as const) {
      await expect(
        previewPendingOnboardingContinuation(TOKEN, {
          get: vi.fn().mockResolvedValue({
            success: true,
            data: {
              platform: "twilio",
              platformUserId: "+14155550123",
              platformDisplayName: "Ada",
              returnUrl,
            },
          }),
          post: vi.fn(),
        }),
      ).resolves.toMatchObject({ returnUrl });
    }
  });
});

describe("completePendingOnboardingContinuation", () => {
  it("redeems exactly once and returns verified absence", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi.fn().mockResolvedValue(successfulRedemption());
    const transport: OnboardingContinuationTransport = { post };

    await expect(
      completePendingOnboardingContinuation(TOKEN, transport),
    ).resolves.toEqual({ presence: "absent" });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/api/eliza-app/onboarding/chat",
      {
        sessionId: TOKEN,
        platform: "web",
        confirmPlatformLink: true,
      },
      { headers: { "Idempotency-Key": "cloud-continuation-confirm-v1" } },
    );
    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("accepts the bounded platform session id returned after continuation resolution", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi
      .fn()
      .mockResolvedValue(successfulRedemption("platform:discord:1234567890"));

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({ presence: "absent" });
  });

  it("returns residual presence after success without repeating the POST", async () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(TOKEN));
    session.behavior.remove = "noop";
    installStoragePair(session, local);
    const post = vi.fn().mockResolvedValue(successfulRedemption());

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(session.readRaw()).not.toBeNull();
  });

  it("keeps the token when the redemption POST fails", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi.fn().mockRejectedValue(new Error("503"));
    const transport: OnboardingContinuationTransport = { post };

    await expect(
      completePendingOnboardingContinuation(TOKEN, transport),
    ).rejects.toThrow("503");
    expect(post).toHaveBeenCalledTimes(1);
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "pending",
    });
  });

  it.each([
    ["empty object", {}],
    ["missing session id", { success: true, data: { requiresLogin: false } }],
    [
      "still requires login",
      { success: true, data: { sessionId: TOKEN, requiresLogin: true } },
    ],
    [
      "handoff-only claim",
      {
        success: true,
        data: {
          sessionId: TOKEN,
          requiresLogin: true,
          handoffComplete: true,
          provisioning: { status: "running" },
        },
      },
    ],
  ])(
    "preserves the pending receipt for an invalid %s response",
    async (_label, response) => {
      storePendingOnboardingSession(TOKEN);
      const post = vi.fn().mockResolvedValue(response);

      await expect(
        completePendingOnboardingContinuation(TOKEN, { post }),
      ).rejects.toThrow("Could not verify the completed messaging connection");
      expect(peekPendingOnboardingSession()).toEqual({
        presence: "present",
        token: TOKEN,
        redemption: "pending",
      });
    },
  );

  it("shares one in-flight POST and one stable non-secret idempotency key", async () => {
    storePendingOnboardingSession(TOKEN);
    let resolvePost!: (value: unknown) => void;
    const post = vi.fn<OnboardingContinuationTransport["post"]>(
      (_path, _body, _init) =>
        new Promise<unknown>((resolve) => {
          resolvePost = resolve;
        }),
    );

    const first = completePendingOnboardingContinuation(TOKEN, { post });
    const second = completePendingOnboardingContinuation(TOKEN, { post });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[2]).toEqual({
      headers: { "Idempotency-Key": "cloud-continuation-confirm-v1" },
    });
    expect(JSON.stringify(post.mock.calls[0]?.[2])).not.toContain(TOKEN);

    resolvePost(successfulRedemption());
    await expect(Promise.all([first, second])).resolves.toEqual([
      { presence: "absent" },
      { presence: "absent" },
    ]);
  });

  it("lets a remounted consumer observe one flight and its retained settlement", async () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(TOKEN));
    session.behavior.remove = "noop";
    installStoragePair(session, local);
    let resolvePost!: (value: unknown) => void;
    const post = vi.fn<OnboardingContinuationTransport["post"]>(
      () =>
        new Promise<unknown>((resolve) => {
          resolvePost = resolve;
        }),
    );

    const completion = completePendingOnboardingContinuation(TOKEN, { post });
    expect(observePendingOnboardingContinuationCompletion(TOKEN)).toBe(
      completion,
    );
    expect(post).toHaveBeenCalledTimes(1);

    resolvePost(successfulRedemption());
    await expect(completion).resolves.toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    const remounted = observePendingOnboardingContinuationCompletion(TOKEN);
    expect(remounted).toBe(completion);
    await expect(remounted).resolves.toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("retains and acknowledges one recent clean settlement for a remounted route", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi.fn().mockResolvedValue(successfulRedemption());

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({ presence: "absent" });
    expect(observeRecentOnboardingContinuationCompletion()).toEqual({
      token: TOKEN,
      state: { presence: "absent" },
    });

    acknowledgeOnboardingContinuationCompletion(TOKEN);
    expect(observeRecentOnboardingContinuationCompletion()).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected flight so explicit retry can reuse the idempotency key", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(successfulRedemption());

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).rejects.toThrow("503");
    expect(observePendingOnboardingContinuationCompletion(TOKEN)).toBeNull();
    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({ presence: "absent" });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((call) => call[2])).toEqual([
      { headers: { "Idempotency-Key": "cloud-continuation-confirm-v1" } },
      { headers: { "Idempotency-Key": "cloud-continuation-confirm-v1" } },
    ]);
  });

  it("skips transport for absent, indeterminate, or different credentials", async () => {
    const post = vi.fn();
    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({ presence: "absent" });

    const session = controlledStorage(storedRecord(OTHER_TOKEN));
    const local = controlledStorage();
    installStoragePair(session, local);
    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toMatchObject({ presence: "present", token: OTHER_TOKEN });
    session.behavior.getThrows = true;
    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({ presence: "indeterminate" });
    expect(post).not.toHaveBeenCalled();
  });

  it("reloads a committed receipt as cleanup-only with zero new POST", async () => {
    const session = controlledStorage(
      storedRecord(TOKEN, undefined, "committed"),
    );
    const local = controlledStorage(
      storedRecord(TOKEN, undefined, "committed"),
    );
    session.behavior.remove = "noop";
    installStoragePair(session, local);
    const post = vi.fn();

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    expect(post).not.toHaveBeenCalled();

    session.behavior.remove = "normal";
    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({ presence: "absent" });
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps a committed sentinel when mixed write/remove no-ops leave pending residue", async () => {
    const session = controlledStorage(storedRecord(TOKEN));
    const local = controlledStorage(storedRecord(TOKEN));
    local.behavior.set = "noop";
    local.behavior.remove = "noop";
    installStoragePair(session, local);
    const post = vi.fn().mockResolvedValue(successfulRedemption());

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    expect(JSON.parse(session.readRaw() ?? "{}")).toMatchObject({
      token: TOKEN,
      redemption: "committed",
    });
    const pendingResidue = JSON.parse(local.readRaw() ?? "{}");
    expect(pendingResidue).toMatchObject({ token: TOKEN });
    expect(pendingResidue).not.toHaveProperty("redemption");
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });

    await expect(
      completePendingOnboardingContinuation(TOKEN, { post }),
    ).resolves.toMatchObject({ redemption: "committed" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("never deletes replacement B when A succeeds in flight", async () => {
    storePendingOnboardingSession(TOKEN);
    let resolvePost!: (value: unknown) => void;
    const post = vi.fn<OnboardingContinuationTransport["post"]>(
      (_path, _body, _init) =>
        new Promise<unknown>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const completion = completePendingOnboardingContinuation(TOKEN, { post });
    window.sessionStorage.setItem(STORAGE_KEY, storedRecord(OTHER_TOKEN));
    window.localStorage.setItem(STORAGE_KEY, storedRecord(OTHER_TOKEN));

    resolvePost(successfulRedemption());
    await expect(completion).resolves.toEqual({
      presence: "present",
      token: OTHER_TOKEN,
      redemption: "pending",
    });
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: OTHER_TOKEN,
      redemption: "pending",
    });
  });

  it("does not partially clear A when any slot is unreadable", () => {
    const session = controlledStorage(
      storedRecord(TOKEN, undefined, "committed"),
    );
    const local = controlledStorage(
      storedRecord(TOKEN, undefined, "committed"),
    );
    session.behavior.getThrows = true;
    installStoragePair(session, local);

    expect(clearPendingOnboardingSessionIfToken(TOKEN)).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    expect(local.readRaw()).not.toBeNull();
  });

  it("rejects an unsanitizable token without transport mutation", async () => {
    const post = vi.fn();
    const transport: OnboardingContinuationTransport = { post };

    await expect(
      completePendingOnboardingContinuation("platform:discord:1", transport),
    ).resolves.toEqual({ presence: "indeterminate" });
    expect(post).not.toHaveBeenCalled();
  });
});
