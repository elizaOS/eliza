/** Owns a private Auth database and a signed localhost HTTPS receiver for Bun tests. */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

export function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export async function received<T>(
  promise: Promise<T>,
  description = "Local webhook",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} did not arrive`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createLocalWebhookFixture(
  reply: (delivery: {
    id: string;
    eventType: string;
    verified: boolean;
  }) => Response | Promise<Response>,
) {
  const directory = await mkdtemp(join(tmpdir(), "login-webhook-"));
  const randomSecret = () => randomBytes(32).toString("hex");
  const environment = {
    NODE_ENV: "test",
    STEWARD_RUNTIME: "bun",
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_PGLITE_PATH: join(directory, "database"),
    STEWARD_MASTER_PASSWORD: randomSecret(),
    STEWARD_JWT_SECRET: randomSecret(),
    STEWARD_KDF_SALT: randomSecret(),
    STEWARD_AUDIT_HMAC_KEY: randomSecret(),
    STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY: randomSecret(),
    // The isolated test database contains only this local receiver's URL.
    STEWARD_ALLOW_PRIVATE_WEBHOOK_NETWORKS: "true",
    DATABASE_URL: "",
    REDIS_URL: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    APP_URL: "https://eliza.app",
  };
  const previous = new Map(
    [...Object.keys(environment), "STEWARD_DB_MODE", "STEWARD_EMBEDDED"].map(
      (name) => [name, process.env[name]],
    ),
  );
  const authorities = getCACertificates("default");
  Object.assign(process.env, environment);
  let endpoint: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => {
    try {
      await endpoint?.stop(true);
    } finally {
      setDefaultCACertificates(authorities);
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const certPath = join(directory, "cert.pem"),
      keyPath = join(directory, "key.pem");
    const certificate = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    if (certificate.exitCode !== 0)
      throw new Error("Could not create local TLS certificate");
    const [cert, key] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    setDefaultCACertificates([...authorities, cert]);
    const { verifyWebhookSignature } = await import(
      "../../src/server/webhooks/index"
    );
    const secret = randomSecret();
    endpoint = Bun.serve({
      hostname: "localhost",
      port: 0,
      tls: { cert, key },
      async fetch(request) {
        const id = request.headers.get("X-Steward-Delivery-Id") ?? "";
        const eventType = request.headers.get("X-Steward-Event") ?? "";
        const verified = verifyWebhookSignature({
          body: await request.text(),
          deliveryId: id,
          eventType,
          sentAt: request.headers.get("X-Steward-Sent-At") ?? "",
          signature: request.headers.get("X-Steward-Signature") ?? "",
          secret,
        });
        return reply({ id, eventType, verified });
      },
    });
    return { url: endpoint.url, secret, close };
  } catch (error) {
    await close();
    throw error;
  }
}
