/**
 * Exercises the production X credential-to-client/profile boundary with a
 * deterministic twitter-api-v2 constructor and rotating broker generations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthenticatedTwitterSession, TwitterAuth } from "./auth";
import type {
  BrokerAuthCredentials,
  TwitterBrokerProvider,
} from "./auth-providers/types";
import { Client } from "./client";

const twitterApiHarness = vi.hoisted(() => {
  type ProfileResult =
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;
  type TwitterApiHarnessValue = {
    v2: {
      me: ReturnType<typeof vi.fn>;
      tweet: ReturnType<typeof vi.fn>;
      user: ReturnType<typeof vi.fn>;
    };
  };
  const profiles: Array<ProfileResult | (() => ProfileResult)> = [];
  const constructorFailures: unknown[] = [];
  const instances: Array<{
    credentials: unknown;
    me: ReturnType<typeof vi.fn>;
    tweet: ReturnType<typeof vi.fn>;
    user: ReturnType<typeof vi.fn>;
    value: TwitterApiHarnessValue;
  }> = [];
  const twitterApiConstructor = vi.fn(function TwitterApiMock(
    credentials: unknown,
  ) {
    if (constructorFailures.length > 0) {
      throw constructorFailures.shift();
    }
    const profile = profiles[instances.length];
    if (!profile) {
      throw new Error("TwitterApiMock profile was not configured");
    }
    const me = vi.fn(async () => ({
      data: await (typeof profile === "function" ? profile() : profile),
    }));
    const instanceNumber = instances.length + 1;
    const tweet = vi.fn(async () => ({
      data: { id: `tweet-${instanceNumber}`, text: "" },
    }));
    const user = vi.fn(async () => ({
      data: {
        id: `profile-${instanceNumber}`,
        username: `screen-${instanceNumber}`,
      },
    }));
    const value = { v2: { me, tweet, user } };
    instances.push({ credentials, me, tweet, user, value });
    return value;
  });

  return {
    constructorFailures,
    instances,
    profiles,
    twitterApiConstructor,
  };
});

vi.mock("twitter-api-v2", () => ({
  TwitterApi: twitterApiHarness.twitterApiConstructor,
}));

type OAuth1Credentials = Extract<BrokerAuthCredentials, { mode: "oauth1" }>;

function oauth1(
  overrides: Partial<Omit<OAuth1Credentials, "mode">> = {},
): OAuth1Credentials {
  return {
    mode: "oauth1",
    appKey: "app-key-one",
    appSecret: "app-secret-one",
    accessToken: "shared-access-token",
    accessSecret: "access-secret-one",
    ...overrides,
  };
}

function user(id: string) {
  return {
    id,
    username: `user-${id}`,
    name: `User ${id}`,
    description: `Profile ${id}`,
    profile_image_url: `https://example.com/${id}.jpg`,
    public_metrics: { followers_count: 1, following_count: 2 },
    verified: false,
    location: "",
    created_at: "2026-08-15T00:00:00.000Z",
  };
}

function rotatingBroker(initial: BrokerAuthCredentials) {
  let credentials = initial;
  const getBrokerCredentials = vi.fn(async () => credentials);
  const provider: TwitterBrokerProvider = {
    mode: "broker",
    getAccessToken: async () => credentials.accessToken,
    getBrokerCredentials,
  };

  return {
    getBrokerCredentials,
    provider,
    rotate(next: BrokerAuthCredentials) {
      credentials = next;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  twitterApiHarness.twitterApiConstructor.mockClear();
  twitterApiHarness.constructorFailures.length = 0;
  twitterApiHarness.instances.length = 0;
  twitterApiHarness.profiles.length = 0;
});

describe("TwitterAuth credential rotation", () => {
  it("rebuilds for every OAuth1 secret or app credential change with the same access token", async () => {
    twitterApiHarness.profiles.push(
      user("one"),
      user("two"),
      user("three"),
      user("four"),
    );
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const clients = [await auth.getV2Client()];
    broker.rotate(oauth1({ appKey: "app-key-two" }));
    clients.push(await auth.getV2Client());
    broker.rotate(
      oauth1({ appKey: "app-key-two", appSecret: "app-secret-two" }),
    );
    clients.push(await auth.getV2Client());
    broker.rotate(
      oauth1({
        appKey: "app-key-two",
        appSecret: "app-secret-two",
        accessSecret: "access-secret-two",
      }),
    );
    clients.push(await auth.getV2Client());

    expect(new Set(clients).size).toBe(4);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(4);
    expect(
      twitterApiHarness.instances.map(({ credentials }) => credentials),
    ).toEqual([
      expect.objectContaining({
        appKey: "app-key-one",
        appSecret: "app-secret-one",
        accessSecret: "access-secret-one",
        accessToken: "shared-access-token",
      }),
      expect.objectContaining({ appKey: "app-key-two" }),
      expect.objectContaining({ appSecret: "app-secret-two" }),
      expect.objectContaining({ accessSecret: "access-secret-two" }),
    ]);
  });

  it("rebuilds when the broker changes OAuth mode without changing the access token", async () => {
    twitterApiHarness.profiles.push(user("oauth1"), user("oauth2"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const oauth1Client = await auth.getV2Client();
    broker.rotate({ mode: "oauth2", accessToken: "shared-access-token" });
    const oauth2Client = await auth.getV2Client();

    expect(oauth2Client).not.toBe(oauth1Client);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accessToken: "shared-access-token" }),
    );
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenNthCalledWith(
      2,
      "shared-access-token",
    );
  });

  it("rebuilds when an OAuth2 broker rotates the access token without changing mode", async () => {
    twitterApiHarness.profiles.push(user("oauth2-one"), user("oauth2-two"));
    const broker = rotatingBroker({
      mode: "oauth2",
      accessToken: "oauth2-token-one",
    });
    const auth = new TwitterAuth(broker.provider);

    const firstClient = await auth.getV2Client();
    await expect(auth.me()).resolves.toMatchObject({ userId: "oauth2-one" });

    broker.rotate({ mode: "oauth2", accessToken: "oauth2-token-two" });
    const secondClient = await auth.getV2Client();
    await expect(auth.me()).resolves.toMatchObject({ userId: "oauth2-two" });

    expect(secondClient).not.toBe(firstClient);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenNthCalledWith(
      1,
      "oauth2-token-one",
    );
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenNthCalledWith(
      2,
      "oauth2-token-two",
    );
  });

  it("invalidates the cached profile on rotation but reuses it for identical credentials", async () => {
    twitterApiHarness.profiles.push(user("old-account"), user("new-account"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    await expect(auth.me()).resolves.toMatchObject({ userId: "old-account" });
    await expect(auth.me()).resolves.toMatchObject({ userId: "old-account" });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(1);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledTimes(1);

    broker.rotate(oauth1({ accessSecret: "access-secret-two" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "new-account" });

    expect(broker.getBrokerCredentials).toHaveBeenCalledTimes(3);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledTimes(1);
    expect(twitterApiHarness.instances[1]?.me).toHaveBeenCalledTimes(1);
  });

  it("stores only a fixed-length digest for credential equality", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const credentials = oauth1();
    const auth = new TwitterAuth(rotatingBroker(credentials).provider);

    await auth.getV2Client();

    const fingerprint = (
      auth as unknown as { generation?: { fingerprint?: string } }
    ).generation?.fingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const secret of [
      credentials.appKey,
      credentials.appSecret,
      credentials.accessToken,
      credentials.accessSecret,
    ]) {
      expect(fingerprint).not.toContain(secret);
    }
  });

  it("serializes concurrent initialization and profile loading", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const clients = await Promise.all([
      auth.getV2Client(),
      auth.getV2Client(),
      auth.getV2Client(),
    ]);
    expect(new Set(clients).size).toBe(1);
    expect(broker.getBrokerCredentials).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    const profiles = await Promise.all([auth.me(), auth.me()]);
    expect(profiles).toEqual([
      expect.objectContaining({ userId: "one" }),
      expect.objectContaining({ userId: "one" }),
    ]);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
  });

  it("revalidates a follower when the broker changes during first initialization", async () => {
    const firstCredentials = deferred<BrokerAuthCredentials>();
    const getBrokerCredentials = vi
      .fn<() => Promise<BrokerAuthCredentials>>()
      .mockImplementationOnce(() => firstCredentials.promise)
      .mockResolvedValue(oauth1({ accessSecret: "account-c-secret" }));
    const provider: TwitterBrokerProvider = {
      mode: "broker",
      getAccessToken: async () => "shared-access-token",
      getBrokerCredentials,
    };
    twitterApiHarness.profiles.push(user("account-b"), user("account-c"));
    const auth = new TwitterAuth(provider);

    const pendingB = auth.me();
    await vi.waitFor(() => expect(getBrokerCredentials).toHaveBeenCalledOnce());
    const accountCCall = auth.me();
    firstCredentials.resolve(oauth1({ accessSecret: "account-b-secret" }));

    await expect(pendingB).resolves.toMatchObject({ userId: "account-c" });
    await expect(accountCCall).resolves.toMatchObject({ userId: "account-c" });
    expect(getBrokerCredentials).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.instances[0]?.me).not.toHaveBeenCalled();
    expect(twitterApiHarness.instances[1]?.me).toHaveBeenCalledOnce();
  });

  it("never resurrects a profile that resolves after rotation", async () => {
    const oldProfile = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(oldProfile.promise, user("new-account"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const startedBeforeRotation = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );

    broker.rotate(oauth1({ accessSecret: "rotated-secret" }));
    const current = auth.me();
    await expect(current).resolves.toMatchObject({ userId: "new-account" });

    oldProfile.resolve(user("old-account"));
    await expect(startedBeforeRotation).resolves.toMatchObject({
      userId: "new-account",
    });
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[1]?.me).toHaveBeenCalledOnce();
  });

  it("ignores a stale profile failure after rotation", async () => {
    const oldProfile = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(oldProfile.promise, user("new-account"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const startedBeforeRotation = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );
    broker.rotate(oauth1({ accessSecret: "rotated-secret" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "new-account" });

    oldProfile.reject(new Error("old credential rejected"));
    await expect(startedBeforeRotation).resolves.toMatchObject({
      userId: "new-account",
    });
  });

  it("drains an active generation before admitting a rotated broker generation without replaying the operation", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);
    const operationStarted = deferred<void>();
    const finishOperation = deferred<void>();
    const failure = new Error("local persistence failed after the X write");
    const operation = vi.fn(async (session: AuthenticatedTwitterSession) => {
      operationStarted.resolve();
      await finishOperation.promise;
      const nestedProfile = await auth.withAuthenticatedSession(
        async (nestedSession) => nestedSession.profile.userId,
      );
      expect(nestedProfile).toBe("account-a");
      const pinnedClient = await auth.withCurrentSession(session, () =>
        auth.getV2Client(),
      );
      expect(pinnedClient).toBe(session.client);
      throw failure;
    });

    const accountAOperation = auth.withAuthenticatedSession(operation);
    await operationStarted.promise;

    broker.rotate(oauth1({ accessSecret: "account-b-secret" }));
    const accountBProfile = auth.me();
    await vi.waitFor(() =>
      expect(broker.getBrokerCredentials).toHaveBeenCalledTimes(2),
    );
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    finishOperation.resolve();
    await expect(accountAOperation).rejects.toBe(failure);
    await expect(accountBProfile).resolves.toMatchObject({
      userId: "account-b",
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(operation.mock.calls[0]?.[0]).toMatchObject({
      profile: { userId: "account-a" },
    });
  });

  it("revalidates a pending A-to-B rotation so a later caller observes broker generation C", async () => {
    twitterApiHarness.profiles.push(
      user("account-a"),
      user("account-b"),
      user("account-c"),
    );
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);
    const operationStarted = deferred<void>();
    const finishOperation = deferred<void>();
    const accountAOperation = auth.withAuthenticatedSession(async (session) => {
      operationStarted.resolve();
      await finishOperation.promise;
      return session.profile.userId;
    });
    await operationStarted.promise;

    broker.rotate(oauth1({ accessSecret: "account-b-secret" }));
    const pendingB = auth.me();
    await vi.waitFor(() =>
      expect(broker.getBrokerCredentials).toHaveBeenCalledTimes(2),
    );
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    broker.rotate(oauth1({ accessSecret: "account-c-secret" }));
    const accountCCall = auth.me();
    finishOperation.resolve();

    await expect(accountAOperation).resolves.toBe("account-a");
    await expect(pendingB).resolves.toMatchObject({ userId: "account-c" });
    await expect(accountCCall).resolves.toMatchObject({ userId: "account-c" });
    expect(broker.getBrokerCredentials).toHaveBeenCalledTimes(3);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(3);
    expect(twitterApiHarness.instances[1]?.me).not.toHaveBeenCalled();
    expect(twitterApiHarness.instances[2]?.me).toHaveBeenCalledOnce();
  });

  it("revokes a detached child pin after the outer session releases", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);
    const resumeDetachedChild = deferred<void>();
    const detachedOperation = vi.fn(
      async (session: AuthenticatedTwitterSession) => session,
    );
    let detachedChild!: Promise<AuthenticatedTwitterSession>;
    let accountAClient: unknown;

    await expect(
      auth.withAuthenticatedSession(async (session) => {
        accountAClient = session.client;
        detachedChild = (async () => {
          await resumeDetachedChild.promise;
          return auth.withAuthenticatedSession(detachedOperation);
        })();
        return session.profile.userId;
      }),
    ).resolves.toBe("account-a");

    broker.rotate(oauth1({ accessSecret: "account-b-secret" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "account-b" });
    resumeDetachedChild.resolve();

    await expect(detachedChild).resolves.toMatchObject({
      profile: { userId: "account-b" },
    });
    expect((await detachedChild).client).not.toBe(accountAClient);
    expect(detachedOperation).toHaveBeenCalledOnce();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });

  it("prevents ABA profile resurrection with credential generations", async () => {
    const firstA = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(
      firstA.promise,
      user("account-b"),
      user("account-a-current"),
    );
    const credentialsA = oauth1();
    const broker = rotatingBroker(credentialsA);
    const auth = new TwitterAuth(broker.provider);

    const staleA = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );
    broker.rotate(oauth1({ accessSecret: "account-b-secret" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "account-b" });
    broker.rotate(credentialsA);
    await expect(auth.me()).resolves.toMatchObject({
      userId: "account-a-current",
    });

    firstA.resolve(user("account-a-stale"));
    await expect(staleA).resolves.toMatchObject({
      userId: "account-a-current",
    });
  });

  it("retries a current-generation profile failure without exposing credential text", async () => {
    const profile = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error("access-secret-one rejected"))
      .mockResolvedValueOnce(user("recovered"));
    twitterApiHarness.profiles.push(profile);
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const firstError = await auth.me().catch((error: unknown) => error);
    expect(firstError).toMatchObject({ code: "X_ME_FETCH_FAILED" });
    expect(String((firstError as Error).message)).not.toContain(
      "access-secret-one",
    );
    expect((firstError as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(firstError)).not.toContain("access-secret-one");
    await expect(auth.me()).resolves.toMatchObject({ userId: "recovered" });
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "401", fields: { code: 401 } },
    { label: "provider auth marker", fields: { code: 400, isAuthError: true } },
  ])(
    "classifies an X $label profile response as rejected credentials without retaining provider details",
    async ({ fields }) => {
      const providerError = Object.assign(
        new Error("access-secret-one rejected"),
        fields,
      );
      twitterApiHarness.profiles.push(() => Promise.reject(providerError));
      const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

      const error = await auth.me().catch((cause: unknown) => cause);

      expect(error).toMatchObject({ code: "X_AUTH_REJECTED" });
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("access-secret-one");
    },
  );

  it("does not misclassify a non-auth 403 response as rejected credentials", async () => {
    const providerError = Object.assign(
      new Error("access-secret-one client forbidden"),
      { code: 403, isAuthError: false },
    );
    twitterApiHarness.profiles.push(() => Promise.reject(providerError));
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const error = await auth.me().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "X_ME_FETCH_FAILED" });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("access-secret-one");
  });

  it("keeps rate limits and provider outages distinct from credential rejection", async () => {
    const providerError = Object.assign(
      new Error("access-secret-one provider overloaded"),
      { code: 429 },
    );
    twitterApiHarness.profiles.push(() => Promise.reject(providerError));
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const error = await auth.me().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "X_ME_FETCH_FAILED" });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((error as Error).message)).not.toContain("access-secret-one");
    expect(JSON.stringify(error)).not.toContain("access-secret-one");
  });

  it("clears a rejected initialization flight so the next call can retry", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const getBrokerCredentials = vi
      .fn<() => Promise<BrokerAuthCredentials>>()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce(oauth1());
    const provider: TwitterBrokerProvider = {
      mode: "broker",
      getAccessToken: async () => "shared-access-token",
      getBrokerCredentials,
    };
    const auth = new TwitterAuth(provider);

    const initializationError = await auth
      .getV2Client()
      .catch((error: unknown) => error);
    expect(initializationError).toMatchObject({
      code: "X_AUTH_INITIALIZATION_FAILED",
      message: "Failed to resolve X credentials",
    });
    expect(
      (initializationError as Error & { cause?: unknown }).cause,
    ).toBeUndefined();
    expect(JSON.stringify(initializationError)).not.toContain(
      "broker unavailable",
    );
    await expect(auth.getV2Client()).resolves.toBeDefined();
    expect(getBrokerCredentials).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
  });

  it("sanitizes twitter-api-v2 constructor failures without retaining credentials", async () => {
    const secret = "constructor-secret-access-token";
    twitterApiHarness.constructorFailures.push(
      new Error(`twitter-api-v2 rejected ${secret}`),
    );
    const auth = new TwitterAuth(
      rotatingBroker(oauth1({ accessToken: secret })).provider,
    );

    const initializationError = await auth
      .getV2Client()
      .catch((error: unknown) => error);

    expect(initializationError).toMatchObject({
      code: "X_AUTH_INITIALIZATION_FAILED",
      message: "Failed to initialize X API client",
    });
    expect(
      (initializationError as Error & { cause?: unknown }).cause,
    ).toBeUndefined();
    expect(String((initializationError as Error).message)).not.toContain(
      secret,
    );
    expect(JSON.stringify(initializationError)).not.toContain(secret);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances).toHaveLength(0);
  });

  it("revokes account A before a rotated account-B constructor failure and recovers on retry", async () => {
    const secret = "account-b-constructor-secret";
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);
    const accountASession = await auth.getAuthenticatedSession();
    expect(auth.isAuthenticatedSessionCurrent(accountASession)).toBe(true);

    broker.rotate(
      oauth1({ accessSecret: secret, accessToken: "account-b-token" }),
    );
    twitterApiHarness.constructorFailures.push(
      new Error(`twitter-api-v2 rejected ${secret}`),
    );
    const rotationError = await auth.me().catch((error: unknown) => error);

    expect(rotationError).toMatchObject({
      code: "X_AUTH_INITIALIZATION_FAILED",
      message: "Failed to initialize X API client",
    });
    expect(
      (rotationError as Error & { cause?: unknown }).cause,
    ).toBeUndefined();
    expect(JSON.stringify(rotationError)).not.toContain(secret);
    expect(auth.isAuthenticatedSessionCurrent(accountASession)).toBe(false);
    expect(auth.hasToken()).toBe(false);
    expect(
      (
        auth as unknown as {
          generation?: unknown;
          profileCache?: unknown;
        }
      ).generation,
    ).toBeUndefined();
    expect(
      (auth as unknown as { profileCache?: unknown }).profileCache,
    ).toBeUndefined();

    await expect(auth.me()).resolves.toMatchObject({ userId: "account-b" });
    expect(auth.hasToken()).toBe(true);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(3);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[1]?.me).toHaveBeenCalledOnce();
  });

  it("cannot construct a client after logout wins credential resolution", async () => {
    const credentials = deferred<BrokerAuthCredentials>();
    const provider: TwitterBrokerProvider = {
      mode: "broker",
      getAccessToken: async () => "shared-access-token",
      getBrokerCredentials: vi.fn(() => credentials.promise),
    };
    const auth = new TwitterAuth(provider);

    const initialization = auth.getV2Client();
    await vi.waitFor(() =>
      expect(provider.getBrokerCredentials).toHaveBeenCalledOnce(),
    );
    await auth.logout();
    credentials.resolve(oauth1());

    await expect(initialization).rejects.toThrow(
      "Twitter API client not initialized",
    );
    expect(twitterApiHarness.twitterApiConstructor).not.toHaveBeenCalled();
  });

  it("cannot return or cache a profile after logout wins profile resolution", async () => {
    const profile = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(profile.promise);
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const pendingProfile = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );
    await auth.logout();
    profile.resolve(user("stale"));

    await expect(pendingProfile).rejects.toThrow(
      "Twitter API client not initialized",
    );
    await expect(auth.me()).rejects.toThrow(
      "Twitter API client not initialized",
    );
  });

  it("public Client.logout invalidates its TwitterAuth", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const client = new Client();
    client.updateAuth(auth);

    await client.getV2Client();
    await client.logout();

    expect(client.getAuth()).toBeNull();
    expect(client.isAuthenticated()).toBe(false);
    await expect(auth.getV2Client()).rejects.toThrow(
      "Twitter API client not initialized",
    );
    await expect(client.getV2Client()).rejects.toThrow("Not authenticated");
  });

  it("public Client.authenticate installs one verified auth session", async () => {
    twitterApiHarness.profiles.push(user("verified"));
    const broker = rotatingBroker(oauth1());
    const client = new Client();

    await client.authenticate(broker.provider);

    expect(client.getAuth()).toBeInstanceOf(TwitterAuth);
    expect(client.isAuthenticated()).toBe(true);
    await expect(client.me()).resolves.toMatchObject({ userId: "verified" });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
  });

  it("public Client.authenticate rejects sanitized verification failures and leaves no auth installed", async () => {
    const secret = "authenticate-secret-access-token";
    const providerError = Object.assign(new Error(`X rejected ${secret}`), {
      code: 401,
    });
    twitterApiHarness.profiles.push(() => Promise.reject(providerError));
    const broker = rotatingBroker(oauth1({ accessToken: secret }));
    const client = new Client();

    const error = await client
      .authenticate(broker.provider)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "X_AUTH_REJECTED" });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(client.getAuth()).toBeNull();
    expect(client.isAuthenticated()).toBe(false);
    await expect(client.getV2Client()).rejects.toThrow("Not authenticated");
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
  });

  it("rejects logout and invalidation inside its own session without hanging or mutating it", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const result = await auth.withAuthenticatedSession(async (session) => {
      expect(() => auth.invalidate()).toThrowError(
        expect.objectContaining({
          code: "X_AUTH_REPLACEMENT_DURING_SESSION",
        }),
      );
      await expect(auth.logout()).rejects.toMatchObject({
        code: "X_AUTH_REPLACEMENT_DURING_SESSION",
      });
      expect(auth.isAuthenticatedSessionCurrent(session)).toBe(true);
      return session.profile.userId;
    });

    expect(result).toBe("one");
    await expect(auth.me()).resolves.toMatchObject({ userId: "one" });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
  });

  it("invalidates the prior TwitterAuth when Client credentials are replaced", async () => {
    twitterApiHarness.profiles.push(user("old"), user("new"));
    const oldAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const newAuth = new TwitterAuth(
      rotatingBroker(oauth1({ accessSecret: "new-secret" })).provider,
    );
    const client = new Client();
    client.updateAuth(oldAuth);
    await expect(client.me()).resolves.toMatchObject({ userId: "old" });

    client.updateAuth(newAuth);

    await expect(oldAuth.getV2Client()).rejects.toMatchObject({
      code: "X_AUTH_NOT_INITIALIZED",
    });
    await expect(client.me()).resolves.toMatchObject({ userId: "new" });
  });

  it("waits for an active account-A operation before constructing replacement account B", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const accountAAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const accountBBroker = rotatingBroker(
      oauth1({ accessSecret: "account-b-secret" }),
    );
    const accountBAuth = new TwitterAuth(accountBBroker.provider);
    const client = new Client();
    client.updateAuth(accountAAuth);
    const operationStarted = deferred<void>();
    const finishOperation = deferred<void>();

    const accountAOperation = client.withAuthenticatedSession(
      async (session) => {
        operationStarted.resolve();
        await finishOperation.promise;
        return session.profile.userId;
      },
    );
    await operationStarted.promise;

    client.updateAuth(accountBAuth);
    const accountBProfile = client.me();
    await Promise.resolve();
    await Promise.resolve();

    expect(accountBBroker.getBrokerCredentials).not.toHaveBeenCalled();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    finishOperation.resolve();
    await expect(accountAOperation).resolves.toBe("account-a");
    await expect(accountBProfile).resolves.toMatchObject({
      userId: "account-b",
    });
    expect(accountBBroker.getBrokerCredentials).toHaveBeenCalledOnce();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });

  it("drains an in-flight account-A tweet before activating account B and does not replay the write", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const accountAAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const accountBBroker = rotatingBroker(
      oauth1({ accessSecret: "account-b-secret" }),
    );
    const accountBAuth = new TwitterAuth(accountBBroker.provider);
    const client = new Client();
    client.updateAuth(accountAAuth);
    await expect(client.me()).resolves.toMatchObject({ userId: "account-a" });

    const accountATweet = deferred<{
      data: { id: string; text: string };
    }>();
    twitterApiHarness.instances[0]?.tweet.mockImplementationOnce(
      () => accountATweet.promise,
    );
    const pendingTweet = client.sendTweet("from-account-a");
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.tweet).toHaveBeenCalledOnce(),
    );

    client.updateAuth(accountBAuth);
    const accountBProfile = client.me();
    await Promise.resolve();
    await Promise.resolve();

    expect(accountBBroker.getBrokerCredentials).not.toHaveBeenCalled();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    accountATweet.resolve({
      data: { id: "tweet-account-a", text: "from-account-a" },
    });
    await expect(pendingTweet).resolves.toMatchObject({
      data: { data: { id: "tweet-account-a" } },
    });
    await expect(accountBProfile).resolves.toMatchObject({
      userId: "account-b",
    });
    await expect(client.sendTweet("from-account-b")).resolves.toMatchObject({
      data: { data: { id: "tweet-2" } },
    });

    expect(twitterApiHarness.instances[0]?.tweet).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[1]?.tweet).toHaveBeenCalledOnce();
    expect(accountBBroker.getBrokerCredentials).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });

  it("drains an in-flight account-A read before activating account B", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const accountAAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const accountBBroker = rotatingBroker(
      oauth1({ accessSecret: "account-b-secret" }),
    );
    const accountBAuth = new TwitterAuth(accountBBroker.provider);
    const client = new Client();
    client.updateAuth(accountAAuth);
    await expect(client.me()).resolves.toMatchObject({ userId: "account-a" });

    const accountAUser = deferred<{
      data: { id: string; username: string };
    }>();
    twitterApiHarness.instances[0]?.user.mockImplementationOnce(
      () => accountAUser.promise,
    );
    const pendingRead = client.getScreenNameByUserId("target-user");
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.user).toHaveBeenCalledOnce(),
    );

    client.updateAuth(accountBAuth);
    const accountBProfile = client.me();
    await Promise.resolve();
    await Promise.resolve();

    expect(accountBBroker.getBrokerCredentials).not.toHaveBeenCalled();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    accountAUser.resolve({
      data: { id: "target-user", username: "screen-account-a" },
    });
    await expect(pendingRead).resolves.toBe("screen-account-a");
    await expect(accountBProfile).resolves.toMatchObject({
      userId: "account-b",
    });
    await expect(client.getScreenNameByUserId("target-user")).resolves.toBe(
      "screen-2",
    );

    expect(twitterApiHarness.instances[0]?.user).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[1]?.user).toHaveBeenCalledOnce();
    expect(accountBBroker.getBrokerCredentials).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });

  it("keeps nested public provider calls on the active Client session", async () => {
    twitterApiHarness.profiles.push(user("account-a"));
    const client = new Client();
    client.updateAuth(new TwitterAuth(rotatingBroker(oauth1()).provider));

    const result = await client.withAuthenticatedSession(async (session) => {
      expect(session.profile.userId).toBe("account-a");
      return client.sendTweet("nested-account-a");
    });

    expect(result).toMatchObject({ data: { data: { id: "tweet-1" } } });
    expect(twitterApiHarness.instances[0]?.tweet).toHaveBeenCalledOnce();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
  });

  it("revokes a detached Client auth pin and permits replacement plus logout after outer release", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const accountAAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const accountBAuth = new TwitterAuth(
      rotatingBroker(oauth1({ accessSecret: "account-b-secret" })).provider,
    );
    const accountCAuth = new TwitterAuth(
      rotatingBroker(oauth1({ accessSecret: "account-c-secret" })).provider,
    );
    const client = new Client();
    client.updateAuth(accountAAuth);
    const resumeDetachedChild = deferred<void>();
    const detachedOperation = vi.fn(
      async (session: AuthenticatedTwitterSession) => session,
    );
    let detachedChild!: Promise<AuthenticatedTwitterSession>;

    await expect(
      client.withAuthenticatedSession(async (session) => {
        const nestedProfile = await client.withAuthenticatedSession(
          async (nestedSession) => nestedSession.profile.userId,
        );
        expect(nestedProfile).toBe("account-a");
        detachedChild = (async () => {
          await resumeDetachedChild.promise;
          const currentSession =
            await client.withAuthenticatedSession(detachedOperation);
          client.updateAuth(accountCAuth);
          await client.logout();
          return currentSession;
        })();
        return session.profile.userId;
      }),
    ).resolves.toBe("account-a");

    client.updateAuth(accountBAuth);
    await expect(client.me()).resolves.toMatchObject({ userId: "account-b" });
    resumeDetachedChild.resolve();

    await expect(detachedChild).resolves.toMatchObject({
      profile: { userId: "account-b" },
    });
    expect(detachedOperation).toHaveBeenCalledOnce();
    expect(client.getAuth()).toBeNull();
    await expect(client.getV2Client()).rejects.toThrow("Not authenticated");
    await expect(accountCAuth.getV2Client()).rejects.toMatchObject({
      code: "X_AUTH_NOT_INITIALIZED",
    });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });

  it("invalidates nested session access when an in-flight Client operation replaces account A with B", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const accountAAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const accountBAuth = new TwitterAuth(
      rotatingBroker(oauth1({ accessSecret: "account-b-secret" })).provider,
    );
    const client = new Client();
    client.updateAuth(accountAAuth);
    const operationStarted = deferred<void>();
    const resumeOperation = deferred<void>();
    const nestedOperation = vi.fn(
      async (session: AuthenticatedTwitterSession) => session.profile.userId,
    );
    const operation = client.withAuthenticatedSession(async (session) => {
      expect(session.profile.userId).toBe("account-a");
      operationStarted.resolve();
      await resumeOperation.promise;
      return client.withAuthenticatedSession(nestedOperation);
    });
    await operationStarted.promise;

    client.updateAuth(accountBAuth);
    resumeOperation.resolve();

    await expect(operation).rejects.toMatchObject({
      code: "X_AUTH_NOT_INITIALIZED",
    });
    expect(nestedOperation).not.toHaveBeenCalled();
    await expect(client.me()).resolves.toMatchObject({ userId: "account-b" });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });
});
