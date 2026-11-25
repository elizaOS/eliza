import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function openNativeBackupSteward(
  options: {
    packageName?: string;
    redirectUri?: string;
    environment?: "production" | "staging";
    beforeGoogleKeys?: () => Promise<void>;
  } = {},
) {
  const packageName = options.packageName ?? "test.grace.backup";
  const redirectUri =
    options.redirectUri ?? "https://app.example.test/native/callback";
  const environment = options.environment ?? "staging";
  const tenantId = "native-backup-tenant";
  const clientId = "native-backup-app";
  const serverClientId = "123-backup-server.apps.googleusercontent.com";
  const presenter = "123-backup-android.apps.googleusercontent.com";
  const signingSecret = randomBytes(32).toString("hex");
  const tenantKey = `stw_${randomBytes(16).toString("hex")}`;
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256" };
  const config: Record<string, string> = {
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_REQUEST_SIGNING_SECRET: signingSecret,
    STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH: "true",
    GOOGLE_CLIENT_ID: serverClientId,
    GOOGLE_CLIENT_SECRET: "synthetic-test-google-secret",
    STEWARD_GOOGLE_NATIVE_CLIENT_IDS: JSON.stringify({
      [clientId]: [presenter],
    }),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
  };
  const previous = Object.fromEntries(
    Object.keys(config).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, config);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      await options.beforeGoogleKeys?.();
      return Response.json({ keys: [jwk] });
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  const { clearOidcJwksCacheForTests } = await import(
    "../../src/server/auth/oidc"
  );
  clearOidcJwksCacheForTests();
  let closeDatabase: (() => Promise<void>) | undefined;
  const close = async () => {
    try {
      await closeDatabase?.();
    } finally {
      clearOidcJwksCacheForTests();
      globalThis.fetch = fetchBefore;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  try {
    const { createPGLiteDb } = await import("../../src/server/db/pglite");
    const { setPGLiteOverride, closeDb } = await import(
      "../../src/server/db/client"
    );
    const { tenants, tenantConfigs, tenantAppClients } = await import(
      "../../src/server/db/schema"
    );
    const { accounts, users, userTenants } = await import(
      "../../src/server/db/schema-auth"
    );
    const db = await createPGLiteDb("memory://");
    setPGLiteOverride(db.db, () => db.client.close());
    closeDatabase = closeDb;
    await db.db.insert(tenants).values({
      id: tenantId,
      name: "Synthetic backup tenant",
      apiKeyHash: createHash("sha256").update(tenantKey).digest("hex"),
    });
    await db.db.insert(tenantConfigs).values({
      tenantId,
      allowedRedirectUrls: [redirectUri],
      joinMode: "open",
    });
    const registration = {
      id: clientId,
      name: "Synthetic backup app",
      tenantId,
      allowedPackageNames: [packageName],
      allowedRedirectUrls: [redirectUri],
      environment,
    };
    await db.db.insert(tenantAppClients).values(registration);
    const email = "native-backup-owner@example.test";
    const subject = "synthetic-linked-google-subject";
    const [owner] = await db.db
      .insert(users)
      .values({ email, emailVerified: true })
      .returning({ id: users.id });
    const [other] = await db.db
      .insert(users)
      .values({
        email: "native-backup-other@example.test",
        emailVerified: true,
      })
      .returning({ id: users.id });
    if (!owner || !other)
      throw new Error("The synthetic backup owners were not created");
    await db.db
      .insert(userTenants)
      .values([owner, other].map(({ id }) => ({ tenantId, userId: id })));
    await db.db.insert(accounts).values({
      userId: owner.id,
      provider: "google",
      providerAccountId: subject,
    });
    const { createLoginApp } = await import("../../src/server/app");
    return {
      app: createLoginApp(),
      db,
      tenantId,
      tenantKey,
      signingSecret,
      ownerId: owner.id,
      otherOwnerId: other.id,
      packageName,
      redirectUri,
      environment,
      serverClientId,
      registration,
      close,
      googleIdToken: (nonce: string) =>
        new SignJWT({ nonce, email, email_verified: true, azp: presenter })
          .setProtectedHeader({ alg: "RS256", kid })
          .setIssuer("https://accounts.google.com")
          .setAudience(serverClientId)
          .setSubject(subject)
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
