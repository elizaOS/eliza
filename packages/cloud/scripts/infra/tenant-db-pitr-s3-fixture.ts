/**
 * Supplies a private, TLS-authenticated S3 protocol fixture for the recovery drill.
 * Its backing files and credentials are generated under the invocation directory;
 * no configured rclone remotes or user credentials are loaded.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export async function startPitrS3Fixture(root) {
  const store = join(root, "s3-store");
  mkdirSync(store, { mode: 0o700 });
  mkdirSync(join(store, "tenant-drill"), { mode: 0o700 });
  const cert = join(root, "s3-cert.pem");
  const key = join(root, "s3-key.pem");
  const sslConfig = join(root, "s3-cert.conf");
  const rcloneConfig = join(root, "rclone.conf");
  const serverLog = join(root, "s3-server.log");
  writeFileSync(
    sslConfig,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    { mode: 0o600 },
  );
  writeFileSync(rcloneConfig, "", { mode: 0o600 });
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-x509",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-config",
      sslConfig,
    ],
    { stdio: "pipe", timeout: 30_000 },
  );
  const untrustedCa = join(root, "untrusted-ca.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-x509",
      "-days",
      "1",
      "-keyout",
      join(root, "untrusted-key.pem"),
      "-out",
      untrustedCa,
      "-config",
      sslConfig,
    ],
    { stdio: "pipe", timeout: 30_000 },
  );
  const accessKey = randomBytes(16).toString("hex");
  const secretKey = randomBytes(32).toString("hex");
  const log = openSync(serverLog, "a", 0o600);
  const server = spawn(
    "rclone",
    [
      "--config",
      rcloneConfig,
      "serve",
      "s3",
      store,
      "--addr",
      "127.0.0.1:0",
      "--cert",
      cert,
      "--key",
      key,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("RCLONE_") && !name.startsWith("PG"),
          ),
        ),
        RCLONE_AUTH_KEY: `"${accessKey},${secretKey}"`,
      },
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  let spawnError;
  server.once("error", (error) => {
    spawnError = error;
  });
  const stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null || spawnError)
      return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 5_000);
      const deadline = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error("Owned S3 fixture did not stop"));
      }, 10_000);
      server.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(deadline);
        resolve();
      });
      server.kill("SIGTERM");
    });
  };
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error(
          `S3 fixture exited before readiness; inspect ${serverLog}`,
        );
      const match = readFileSync(serverLog, "utf8").match(
        /https:\/\/127\.0\.0\.1:(\d+)/,
      );
      if (match) {
        return {
          endpoint: `https://127.0.0.1:${match[1]}`,
          untrustedCa,
          settings: `repo1-type=s3\nrepo1-path=/recovery\nrepo1-s3-bucket=tenant-drill\nrepo1-s3-endpoint=127.0.0.1\nrepo1-s3-port=${match[1]}\nrepo1-s3-region=us-east-1\nrepo1-s3-uri-style=path\nrepo1-s3-key=${accessKey}\nrepo1-s3-key-secret=${secretKey}\nrepo1-storage-ca-file=${cert}\nrepo1-storage-verify-tls=y\n`,
          stop,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `S3 fixture did not report its local TLS endpoint; inspect ${serverLog}`,
    );
  } catch (error) {
    // error-policy:J2 retain startup failure after stopping only this invocation's server.
    await stop();
    throw new Error("Could not start isolated S3 fixture", { cause: error });
  }
}
