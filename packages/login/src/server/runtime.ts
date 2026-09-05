/**
 * Starts the identity API with an owned embedded or PostgreSQL database.
 * The application host supplies the persisted vault password before startup;
 * database migrations and authentication initialization finish before listening.
 */
import { ElizaError } from "@elizaos/core/errors";

let activeOwner: symbol | undefined;

/** Starts one embedded identity database per process and releases ownership on shutdown. */
export function startEmbeddedLogin(options: { port?: number } = {}) {
  return startLoginRuntime({
    ...options,
    mode: "embedded",
    hostname: "127.0.0.1",
  });
}

export function startLoginServer(
  options: { port?: number; hostname?: string } = {},
) {
  return startLoginRuntime({
    ...options,
    mode: "postgres",
    hostname: options.hostname ?? process.env.LOGIN_BIND_HOST ?? "127.0.0.1",
  });
}

async function startLoginRuntime(options: {
  port?: number;
  hostname: string;
  mode: "embedded" | "postgres";
}) {
  if (activeOwner) {
    throw new ElizaError(
      "A login server is already starting or running in this process",
      {
        code: "LOGIN_ALREADY_RUNNING",
      },
    );
  }
  const owner = Symbol("login-runtime");
  activeOwner = owner;
  const release = () => {
    if (activeOwner === owner) activeOwner = undefined;
  };
  try {
    const server = await startOwnedLogin(options);
    return {
      port: server.port,
      async stop(): Promise<void> {
        try {
          await server.stop();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    // error-policy:J2 release process ownership while preserving the startup failure.
    release();
    throw new ElizaError("Unable to start the login server", {
      code: "LOGIN_STARTUP_FAILED",
      cause: error,
    });
  }
}

async function startOwnedLogin(options: {
  port?: number;
  hostname: string;
  mode: "embedded" | "postgres";
}) {
  const port = options.port ?? Number(process.env.PORT ?? "3200");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ElizaError("Login port must be an integer from 0 to 65535", {
      code: "LOGIN_PORT_INVALID",
      context: { port },
    });
  }
  if (!process.env.STEWARD_MASTER_PASSWORD?.trim()) {
    throw new ElizaError(
      "The application host must supply its persisted login vault password",
      {
        code: "LOGIN_MASTER_PASSWORD_REQUIRED",
      },
    );
  }
  const { setPGLiteOverride, closeDb, getDatabaseDriver } = await import(
    "./db/src/client"
  );
  let closeRedis: (() => Promise<void>) | undefined;
  let clearRateLimiter: (() => void) | undefined;
  const { setEmbeddedAuthDatabase } = await import("./auth/src/store-backends");
  const { setDatabaseRevocationStore } = await import("./auth/src/revocation");
  const { DatabaseRevocationStore } = await import(
    "./auth/src/database-revocation"
  );
  try {
    if (options.mode === "embedded") {
      process.env.STEWARD_DB_MODE = "pglite";
      process.env.STEWARD_EMBEDDED = "true";
      const { createPGLiteDb, getDataDir } = await import("./db/src/pglite");
      if (process.env.STEWARD_PGLITE_MEMORY !== "true") {
        const { resolveEmbeddedSecrets } = await import("./embedded-secrets");
        const secrets = resolveEmbeddedSecrets(
          getDataDir(),
          process.env.STEWARD_MASTER_PASSWORD,
          {
            kdfSalt: process.env.STEWARD_KDF_SALT,
            auditKey: process.env.STEWARD_AUDIT_HMAC_KEY,
          },
        );
        process.env.STEWARD_KDF_SALT = secrets.kdfSalt;
        process.env.STEWARD_AUDIT_HMAC_KEY = secrets.auditKey;
      }

      const database = await createPGLiteDb();
      setPGLiteOverride(database.db, () => database.client.close());
    } else {
      if (getDatabaseDriver() !== "postgres-js") {
        throw new ElizaError(
          "The login service requires the transactional postgres-js database driver",
          { code: "LOGIN_DATABASE_DRIVER_INVALID" },
        );
      }
      process.env.STEWARD_DB_MODE = "postgres";
      process.env.STEWARD_EMBEDDED = "false";
      const { runMigrations } = await import("./db/src/migrate");
      await runMigrations();
    }
    setEmbeddedAuthDatabase(options.mode === "embedded");
    setDatabaseRevocationStore(new DatabaseRevocationStore());
    const { createLoginApp } = await import("./app");
    const { initializeDefaultTenant } = await import(
      "./api/src/services/context"
    );
    await initializeDefaultTenant();
    const {
      initAuthStores,
      assertAuthStoresAreSafe,
      setDatabaseAuthRateLimiter,
    } = await import("./api/src/routes/auth");
    const { initRedis, shutdownRedis } = await import(
      "./api/src/middleware/redis"
    );
    const { getConfiguredVault } = await import(
      "./api/src/services/vault-factory"
    );
    const { SOCKET_PEER_ENV_KEY } = await import(
      "./api/src/services/runtime-gate"
    );
    closeRedis = shutdownRedis;
    clearRateLimiter = () => setDatabaseAuthRateLimiter(undefined);
    const redisAvailable = await initRedis();
    await initAuthStores(options.mode === "postgres" && !redisAvailable);
    assertAuthStoresAreSafe();
    const { checkDatabaseAuthRateLimit } = await import(
      "./auth/src/database-rate-limit"
    );
    setDatabaseAuthRateLimiter(checkDatabaseAuthRateLimit);
    getConfiguredVault();
    const app = createLoginApp();
    const server = Bun.serve({
      hostname: options.hostname,
      port,
      fetch(request, listener) {
        return app.fetch(request, {
          [SOCKET_PEER_ENV_KEY]: listener.requestIP(request)?.address ?? null,
        });
      },
    });
    let closing: Promise<void> | undefined;
    return {
      port: server.port,
      stop(): Promise<void> {
        closing ??= (async () => {
          const listener = await Promise.allSettled([server.stop(true)]);
          setDatabaseAuthRateLimiter(undefined);
          setEmbeddedAuthDatabase(false);
          setDatabaseRevocationStore(undefined);
          const storage = await Promise.allSettled([
            closeDb(),
            shutdownRedis(),
          ]);
          const failures = [...listener, ...storage].flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length > 0) {
            throw new ElizaError("Unable to close the login service cleanly", {
              code: "LOGIN_SHUTDOWN_FAILED",
              cause: new AggregateError(failures),
            });
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    // error-policy:J2 preserve the startup failure after closing the owned database.
    clearRateLimiter?.();
    setEmbeddedAuthDatabase(false);
    setDatabaseRevocationStore(undefined);
    const teardown = await Promise.allSettled([
      closeDb(),
      ...(closeRedis ? [closeRedis()] : []),
    ]);
    throw new ElizaError("Login startup failed", {
      code: "LOGIN_STARTUP_FAILED",
      cause: error,
      context: {
        teardownFailed: teardown.some((result) => result.status === "rejected"),
      },
    });
  }
}
