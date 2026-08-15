/**
 * Authenticates X API calls across static, PKCE, and managed broker credentials.
 * The complete effective credential tuple identifies the cached client; changing
 * any OAuth field or mode discards the authenticated profile before reuse.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { ElizaError, logger } from "@elizaos/core";
import { TwitterApi } from "twitter-api-v2";
import type {
  BrokerAuthCredentials,
  TwitterAuthProvider,
  TwitterBrokerProvider,
  TwitterOAuth1Provider,
} from "./auth-providers/types";
import type { Profile } from "./profile";

function credentialFingerprint(
  key: Buffer,
  providerMode: TwitterAuthProvider["mode"],
  credentials: BrokerAuthCredentials,
): string {
  const values =
    credentials.mode === "oauth1"
      ? [
          providerMode,
          credentials.mode,
          credentials.appKey,
          credentials.appSecret,
          credentials.accessToken,
          credentials.accessSecret,
        ]
      : [providerMode, credentials.mode, credentials.accessToken];
  const hash = createHmac("sha256", key);
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
  }
  return hash.digest("hex");
}

function isCredentialRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; isAuthError?: unknown };
  return candidate.isAuthError === true || candidate.code === 401;
}

type ClientGeneration = {
  id: number;
  fingerprint: string;
  client: TwitterApi;
};

type SessionContext = {
  generation: ClientGeneration;
  active: boolean;
};

export type AuthenticatedTwitterSession = {
  client: TwitterApi;
  profile: Profile;
  revision: number;
};

/**
 * Twitter API v2 authentication using developer credentials
 */
export class TwitterAuth {
  private generation?: ClientGeneration;
  private nextGeneration = 0;
  private lifecycle = 0;
  private authenticated = false;
  private loggedOut = false;
  private activation: Promise<void> = Promise.resolve();
  private activeSessions = 0;
  private admissionBarrier?: { promise: Promise<void>; resolve: () => void };
  private sessionDrain?: { promise: Promise<void>; resolve: () => void };
  private readonly fingerprintKey = randomBytes(32);
  private generationGate: Promise<void> = Promise.resolve();
  private readonly sessionContext = new AsyncLocalStorage<SessionContext>();
  private initialization?: {
    lifecycle: number;
    promise: Promise<ClientGeneration>;
    state: { revalidationRequested: boolean };
  };
  private profileCache?: { generation: number; profile: Profile };
  private readonly profileLoads = new Map<number, Promise<Profile>>();

  constructor(private readonly provider: TwitterAuthProvider) {
    if (this.isOAuth1Provider(provider)) {
      this.authenticated = true;
    }
  }

  private isOAuth1Provider(p: TwitterAuthProvider): p is TwitterOAuth1Provider {
    const candidate = p as { getOAuth1Credentials?: unknown };
    return typeof candidate.getOAuth1Credentials === "function";
  }

  private isBrokerProvider(p: TwitterAuthProvider): p is TwitterBrokerProvider {
    const candidate = p as { getBrokerCredentials?: unknown };
    return typeof candidate.getBrokerCredentials === "function";
  }

  private async resolveCredentials(): Promise<BrokerAuthCredentials> {
    if (this.isBrokerProvider(this.provider)) {
      return this.provider.getBrokerCredentials();
    }
    if (this.isOAuth1Provider(this.provider)) {
      return {
        mode: "oauth1",
        ...(await this.provider.getOAuth1Credentials()),
      };
    }
    return {
      mode: "oauth2",
      accessToken: await this.provider.getAccessToken(),
    };
  }

  private async initializeClient(lifecycle: number): Promise<ClientGeneration> {
    this.assertActiveLifecycle(lifecycle);
    let credentials: BrokerAuthCredentials;
    // error-policy:J1 provider boundary translates potentially secret-bearing
    // credential resolution failures into one safe connector error.
    try {
      credentials = await this.resolveCredentials();
    } catch {
      throw new ElizaError("Failed to resolve X credentials", {
        code: "X_AUTH_INITIALIZATION_FAILED",
      });
    }
    const fingerprint = credentialFingerprint(
      this.fingerprintKey,
      this.provider.mode,
      credentials,
    );
    const preparation = await this.runGenerationExclusive(async () => {
      this.assertActiveLifecycle(lifecycle);
      if (this.generation?.fingerprint === fingerprint) {
        return { current: this.generation };
      }
      return { releaseAdmission: this.closeSessionAdmission() };
    });
    if (preparation.current) return preparation.current;

    try {
      await this.waitForSessions();
      return await this.runGenerationExclusive(async () => {
        this.assertActiveLifecycle(lifecycle);
        if (this.generation?.fingerprint === fingerprint) {
          return this.generation;
        }
        // Once a different tuple owns admission, the previous identity is no
        // longer valid even if constructing the replacement client fails.
        this.generation = undefined;
        this.profileCache = undefined;
        this.profileLoads.clear();
        this.authenticated = false;
        let client: TwitterApi;
        // error-policy:J1 the library constructor may echo credential values in
        // validation errors, so this boundary deliberately drops its payload.
        try {
          client =
            credentials.mode === "oauth1"
              ? new TwitterApi({
                  appKey: credentials.appKey,
                  appSecret: credentials.appSecret,
                  accessToken: credentials.accessToken,
                  accessSecret: credentials.accessSecret,
                })
              : new TwitterApi(credentials.accessToken);
        } catch {
          throw new ElizaError("Failed to initialize X API client", {
            code: "X_AUTH_INITIALIZATION_FAILED",
          });
        }
        const generation = {
          id: ++this.nextGeneration,
          fingerprint,
          client,
        };
        this.generation = generation;
        this.authenticated = true;
        return generation;
      });
    } finally {
      preparation.releaseAdmission?.();
    }
  }
  private assertActiveLifecycle(lifecycle: number): void {
    if (this.loggedOut || this.lifecycle !== lifecycle) {
      throw new ElizaError("Twitter API client not initialized", {
        code: "X_AUTH_NOT_INITIALIZED",
      });
    }
  }

  private isCurrent(generation: ClientGeneration): boolean {
    return !this.loggedOut && this.generation === generation;
  }

  private async runGenerationExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.generationGate;
    let release: () => void = () => undefined;
    this.generationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureClientInitialized(): Promise<ClientGeneration> {
    await this.activation;
    const context = this.sessionContext.getStore();
    if (context?.active) {
      if (this.loggedOut) {
        throw new ElizaError("Twitter API client not initialized", {
          code: "X_AUTH_NOT_INITIALIZED",
        });
      }
      return context.generation;
    }
    if (this.loggedOut) {
      throw new ElizaError("Twitter API client not initialized", {
        code: "X_AUTH_NOT_INITIALIZED",
      });
    }
    const lifecycle = this.lifecycle;
    if (this.initialization?.lifecycle === lifecycle) {
      // Providers expose no credential revision, so a follower may represent a
      // newer tuple even during first initialization. Followers share one
      // subsequent read; identical tuples still reuse the client and profile.
      this.initialization.state.revalidationRequested = true;
      return this.initialization.promise;
    }

    const state = { revalidationRequested: false };
    const promise = this.runInitializationFlight(lifecycle, state);
    const initialization = { lifecycle, promise, state };
    this.initialization = initialization;
    try {
      return await promise;
    } finally {
      if (this.initialization === initialization) {
        this.initialization = undefined;
      }
    }
  }

  private async runInitializationFlight(
    lifecycle: number,
    state: { revalidationRequested: boolean },
  ): Promise<ClientGeneration> {
    let generation: ClientGeneration;
    do {
      state.revalidationRequested = false;
      generation = await this.initializeClient(lifecycle);
    } while (state.revalidationRequested);
    return generation;
  }

  private async fetchProfile(client: TwitterApi): Promise<Profile> {
    // error-policy:J1 X API boundary classifies credential rejection while
    // stripping provider payloads, tokens, and transport details.
    try {
      const { data: user } = await client.v2.me({
        "user.fields": [
          "id",
          "name",
          "username",
          "description",
          "profile_image_url",
          "public_metrics",
          "verified",
          "location",
          "created_at",
        ],
      });

      return {
        userId: user.id,
        username: user.username,
        name: user.name,
        biography: user.description,
        avatar: user.profile_image_url,
        followersCount: user.public_metrics?.followers_count,
        followingCount: user.public_metrics?.following_count,
        isVerified: user.verified,
        location: user.location || "",
        joined: user.created_at ? new Date(user.created_at) : undefined,
      };
    } catch (error) {
      if (isCredentialRejection(error)) {
        throw new ElizaError("X rejected the authenticated credentials", {
          code: "X_AUTH_REJECTED",
        });
      }
      throw new ElizaError("Failed to fetch authenticated user profile", {
        code: "X_ME_FETCH_FAILED",
      });
    }
  }

  private profileFor(generation: ClientGeneration): Promise<Profile> {
    if (this.profileCache?.generation === generation.id) {
      return Promise.resolve(this.profileCache.profile);
    }

    const activeLoad = this.profileLoads.get(generation.id);
    if (activeLoad) {
      return activeLoad;
    }

    let load: Promise<Profile>;
    load = this.fetchProfile(generation.client)
      .then((profile) => {
        if (this.isCurrent(generation)) {
          this.profileCache = { generation: generation.id, profile };
        }
        return profile;
      })
      .finally(() => {
        if (this.profileLoads.get(generation.id) === load) {
          this.profileLoads.delete(generation.id);
        }
      });
    this.profileLoads.set(generation.id, load);
    return load;
  }

  /**
   * Get the Twitter API v2 client
   */
  async getV2Client(): Promise<TwitterApi> {
    return (await this.ensureClientInitialized()).client;
  }

  /**
   * Check if authenticated
   */
  async isLoggedIn(): Promise<boolean> {
    // error-policy:J4 availability probe — this method's contract is a boolean
    // "are we authenticated" answer, so any init/verify failure is the designed
    // false, not a masked read. Callers that need the failure call me() instead.
    try {
      return await this.withAuthenticatedSession(
        async (session) =>
          typeof session.profile.userId === "string" &&
          session.profile.userId.length > 0,
      );
    } catch {
      // error-policy:J4 initialization failures are represented by the same
      // not-logged-in result; callers that need the cause use me().
      logger.debug(
        "[X.TwitterAuth] credential verification failed; reporting not-logged-in",
      );
      return false;
    }
  }

  /**
   * Get current user profile
   */
  async me(): Promise<Profile | undefined> {
    return (await this.getAuthenticatedSession()).profile;
  }

  async getAuthenticatedSession(): Promise<AuthenticatedTwitterSession> {
    return this.withAuthenticatedSession(async (session) => session);
  }

  async withAuthenticatedSession<T>(
    operation: (session: AuthenticatedTwitterSession) => Promise<T>,
  ): Promise<T> {
    const context = this.sessionContext.getStore();
    if (context?.active) {
      if (this.loggedOut) {
        throw new ElizaError("Twitter API client not initialized", {
          code: "X_AUTH_NOT_INITIALIZED",
        });
      }
      const profile = await this.profileFor(context.generation);
      if (context.active) {
        if (this.loggedOut) {
          throw new ElizaError("Twitter API client not initialized", {
            code: "X_AUTH_NOT_INITIALIZED",
          });
        }
        return operation({
          client: context.generation.client,
          profile,
          revision: context.generation.id,
        });
      }
    }

    while (true) {
      const generation = await this.ensureClientInitialized();
      let profile: Profile;
      // error-policy:J7 a superseded generation's profile failure is observed
      // by the current-generation retry; current failures still propagate.
      try {
        profile = await this.profileFor(generation);
      } catch (error) {
        if (this.isCurrent(generation)) throw error;
        continue;
      }
      if (!this.isCurrent(generation)) continue;
      const release = await this.acquireSession(generation);
      if (!release) continue;
      const activeContext: SessionContext = { generation, active: true };
      try {
        return await this.sessionContext.run(activeContext, () =>
          operation({
            client: generation.client,
            profile,
            revision: generation.id,
          }),
        );
      } finally {
        activeContext.active = false;
        release();
      }
    }
  }

  isAuthenticatedSessionCurrent(
    session: Pick<AuthenticatedTwitterSession, "client" | "revision">,
  ): boolean {
    return (
      !this.loggedOut &&
      this.generation?.id === session.revision &&
      this.generation.client === session.client
    );
  }

  async withCurrentSession<T>(
    session: Pick<AuthenticatedTwitterSession, "client" | "revision">,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runGenerationExclusive(async () => {
      if (!this.isAuthenticatedSessionCurrent(session)) {
        throw new ElizaError("X credentials rotated during identity refresh", {
          code: "X_AUTH_SESSION_ROTATED",
        });
      }
      const result = await operation();
      if (!this.isAuthenticatedSessionCurrent(session)) {
        throw new ElizaError("X credentials rotated during identity refresh", {
          code: "X_AUTH_SESSION_ROTATED",
        });
      }
      return result;
    });
  }

  /** Invalidates this credential object before a Client replaces it. */
  invalidate(): void {
    if (this.sessionContext.getStore()?.active) {
      throw new ElizaError(
        "Cannot replace X credentials inside an authenticated operation",
        { code: "X_AUTH_REPLACEMENT_DURING_SESSION" },
      );
    }
    if (this.loggedOut) return;
    this.loggedOut = true;
    this.lifecycle += 1;
    this.generation = undefined;
    this.authenticated = false;
    this.initialization = undefined;
    this.profileCache = undefined;
    this.profileLoads.clear();
    this.fingerprintKey.fill(0);
  }

  private closeSessionAdmission(): () => void {
    if (this.admissionBarrier) {
      throw new ElizaError("X credential rotation is already in progress", {
        code: "X_AUTH_ROTATION_CONFLICT",
      });
    }
    let resolve!: () => void;
    const promise = new Promise<void>((onResolve) => {
      resolve = onResolve;
    });
    const barrier = { promise, resolve };
    this.admissionBarrier = barrier;
    return () => {
      if (this.admissionBarrier !== barrier) return;
      this.admissionBarrier = undefined;
      barrier.resolve();
    };
  }

  private async acquireSession(
    generation: ClientGeneration,
  ): Promise<(() => void) | undefined> {
    while (this.admissionBarrier) {
      await this.admissionBarrier.promise;
    }
    if (this.loggedOut) {
      throw new ElizaError("Twitter API client not initialized", {
        code: "X_AUTH_NOT_INITIALIZED",
      });
    }
    if (!this.isCurrent(generation)) return undefined;
    this.activeSessions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSessions -= 1;
      if (this.activeSessions === 0 && this.sessionDrain) {
        this.sessionDrain.resolve();
        this.sessionDrain = undefined;
      }
    };
  }

  private waitForSessions(): Promise<void> {
    if (this.activeSessions === 0) return Promise.resolve();
    if (!this.sessionDrain) {
      let resolve!: () => void;
      const promise = new Promise<void>((onResolve) => {
        resolve = onResolve;
      });
      this.sessionDrain = { promise, resolve };
    }
    return this.sessionDrain.promise;
  }

  /** Defers this credential object's first use until the prior auth is quiescent. */
  deferUntil(barrier: Promise<void>): void {
    this.activation = Promise.all([this.activation, barrier]).then(
      () => undefined,
    );
  }

  /**
   * Logout (clear credentials)
   */
  async logout(): Promise<void> {
    this.invalidate();
    await Promise.all([this.activation, this.waitForSessions()]);
    await this.runGenerationExclusive(async () => undefined);
  }

  hasToken(): boolean {
    return this.authenticated && !this.loggedOut;
  }
}
