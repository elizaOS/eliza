/** Exercises actual KMS HTTP, signature recovery and recipient decryption with ephemeral test keys. */
import { spawn, spawnSync } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, SigningKey } from "ethers";
import { afterEach, expect, it } from "vitest";
import { encryptConfidentialEnvironment } from "./confidential-environment.ts";
import { signConfidentialRelease } from "./confidential-release.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(change = "none") {
  const authority = generateKeyPairSync("ed25519");
  const privatePem = authority.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicPem = authority.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const agentId = "a17e934a-d1be-4115-87ca-a7f1b379f390";
  const release = {
    agentId,
    compose: JSON.stringify({
      name: `eliza-${agentId}`,
      manifest_version: "3",
      key_provider: "kms",
      key_provider_id: "aabb",
      public_logs: false,
      public_sysinfo: false,
      no_instance_id: false,
      secure_time: true,
      storage_discard: false,
      requirements: { platforms: ["dstack-tdx"] },
      allowed_envs: [
        "SYNTHETIC_SECRET",
        "ELIZA_DSTACK_RELEASE_POLICY_JSON",
        "ELIZA_DSTACK_LAUNCH_AUTHORIZATION_JSON",
      ],
    }),
    variant: "dstack-tdx",
    osImageHash: "a".repeat(64),
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const appId = createHash("sha256")
    .update(release.compose)
    .digest("hex")
    .slice(0, 40);
  const recipient = generateKeyPairSync("x25519");
  const x = recipient.publicKey.export({ format: "jwk" }).x;
  if (!x) throw new Error("Missing recipient key");
  const publicKey = Buffer.from(x, "base64url").toString("hex");
  const signer = new SigningKey(`0x${"12".repeat(32)}`);
  const timestamp =
    Math.floor(Date.now() / 1000) +
    (change === "old" ? -301 : change === "future" ? 61 : 0);
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(timestamp));
  const digest = keccak256(
    Buffer.concat([
      Buffer.from("dstack-env-encrypt-pubkey:"),
      Buffer.from(change === "wrong-app" ? "ee".repeat(20) : appId, "hex"),
      time,
      Buffer.from(publicKey, "hex"),
    ]),
  );
  const signature = signer.sign(digest);
  const signed = `${signature.r.slice(2) + signature.s.slice(2)}0${signature.yParity}`;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString());
    if (change === "redirect") {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
      return;
    }
    res.end(
      JSON.stringify({
        public_key: change === "wrong-key" ? "ff".repeat(32) : publicKey,
        timestamp: String(timestamp),
        ...(change === "legacy"
          ? { signature: signed }
          : { signature_v1: signed }),
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  return {
    publicPem,
    privatePem,
    recipient,
    requests,
    appId,
    input: {
      release,
      envelope: signConfidentialRelease(release, privatePem),
      endpoint: `http://127.0.0.1:${address.port}`,
      kmsSigningPublicKey: (change === "wrong-signer"
        ? new SigningKey(`0x${"13".repeat(32)}`)
        : signer
      ).compressedPublicKey.slice(2),
      environment: [
        {
          key: "SYNTHETIC_SECRET",
          value: `complete-雪-${"s".repeat(100_000)}`,
        },
      ],
    },
  };
}

it("encrypts the complete environment and exact release for the authenticated recipient only", async () => {
  const f = await fixture();
  const result = await encryptConfidentialEnvironment(
    f.input,
    f.publicPem,
    f.privatePem,
  );
  expect(result.appId).toBe(f.appId);
  expect(f.requests).toEqual([JSON.stringify({ app_id: f.appId })]);
  const bytes = Buffer.from(result.encryptedEnv, "hex");
  const peer = createPublicKey({
    format: "jwk",
    key: {
      kty: "OKP",
      crv: "X25519",
      x: bytes.subarray(0, 32).toString("base64url"),
    },
  });
  const shared = diffieHellman({
    privateKey: f.recipient.privateKey,
    publicKey: peer,
  });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    shared,
    bytes.subarray(32, 44),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  const decrypted = Buffer.concat([
    decipher.update(bytes.subarray(44, -16)),
    decipher.final(),
  ]);
  const decoded: { env: Array<{ key: string; value: string }> } = JSON.parse(
    decrypted.toString(),
  );
  expect(decoded.env).toContainEqual(f.input.environment[0]);
  expect(decoded.env).toContainEqual({
    key: "ELIZA_DSTACK_RELEASE_POLICY_JSON",
    value: JSON.stringify(f.input.envelope),
  });
  const directory = await mkdtemp(
    join(tmpdir(), "eliza-confidential-bootstrap-"),
  );
  try {
    const config = join(directory, "config.json");
    const entry = join(directory, "entry.mjs");
    const marker = join(directory, "imported");
    await writeFile(
      entry,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv));`,
    );
    await writeFile(
      config,
      JSON.stringify({
        entry,
        publicKey: f.publicPem,
        environmentNames: ["SYNTHETIC_SECRET"],
      }),
    );
    const bootstrap = fileURLToPath(
      new URL("../../deploy/confidential-bootstrap.mjs", import.meta.url),
    );
    const environment = Object.fromEntries(
      decoded.env.map(({ key, value }) => [key, value]),
    );
    const invoke = (env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [bootstrap, config], {
        env,
        encoding: "utf8",
      });
    const accepted = invoke(environment);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([
      process.execPath,
      entry,
    ]);
    await rm(marker);
    for (const changed of [
      { ...environment, SYNTHETIC_SECRET: "substituted" },
      { ...environment, ELIZA_DSTACK_RELEASE_POLICY_JSON: "{}" },
      { ...environment, ELIZA_DSTACK_LAUNCH_AUTHORIZATION_JSON: "{}" },
      { ...environment, SYNTHETIC_SECRET: undefined },
    ]) {
      const rejected = invoke(changed);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).not.toContain("complete-雪-");
      await expect(readFile(marker)).rejects.toThrow();
    }
    await writeFile(
      config,
      JSON.stringify({ entry, publicKey: f.publicPem, environmentNames: [] }),
    );
    expect(invoke(environment).status).toBe(1);
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const other = await encryptConfidentialEnvironment(
    f.input,
    f.publicPem,
    f.privatePem,
  );
  expect(other.encryptedEnv).not.toBe(result.encryptedEnv);
});
it.each([
  "old",
  "future",
  "wrong-app",
  "wrong-key",
  "wrong-signer",
  "legacy",
  "redirect",
])("rejects %s KMS material without returning ciphertext", async (change) => {
  const f = await fixture(change);
  await expect(
    encryptConfidentialEnvironment(f.input, f.publicPem, f.privatePem),
  ).rejects.toMatchObject({ code: "CONFIDENTIAL_ENVIRONMENT_REJECTED" });
  expect(f.requests).toHaveLength(1);
});
it("rejects release substitution and duplicate or reserved launch names before HTTP", async () => {
  const f = await fixture();
  for (const input of [
    {
      ...f.input,
      release: { ...f.input.release, compose: `${f.input.release.compose} ` },
    },
    {
      ...f.input,
      environment: [...f.input.environment, ...f.input.environment],
    },
    {
      ...f.input,
      environment: [
        { key: "ELIZA_DSTACK_RELEASE_POLICY_JSON", value: "forged" },
      ],
    },
    {
      ...f.input,
      environment: [{ key: "UNMEASURED_SECRET", value: "secret" }],
    },
  ])
    await expect(
      encryptConfidentialEnvironment(input, f.publicPem, f.privatePem),
    ).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it("refuses an authorized compose with additional unsigned launch variables", async () => {
  const f = await fixture();
  const manifest = JSON.parse(f.input.release.compose);
  manifest.allowed_envs.push("UNSIGNED_EXTRA");
  const release = { ...f.input.release, compose: JSON.stringify(manifest) };
  await expect(
    encryptConfidentialEnvironment(
      {
        ...f.input,
        release,
        envelope: signConfidentialRelease(release, f.privatePem),
      },
      f.publicPem,
      f.privatePem,
    ),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it("runs the real encryption CLI and writes exclusive private ciphertext without secret output", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "eliza-encrypt-env-"));
  try {
    const input = join(directory, "private.json");
    const authority = join(directory, "authority.pem");
    const key = join(directory, "key.pem");
    const output = join(directory, "encrypted.json");
    await writeFile(input, JSON.stringify(f.input), { mode: 0o600 });
    await writeFile(authority, f.publicPem);
    await writeFile(key, f.privatePem, { mode: 0o600 });
    const script = fileURLToPath(
      new URL(
        "../../scripts/encrypt-confidential-environment.ts",
        import.meta.url,
      ),
    );
    const run = () =>
      new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(
          "bun",
          [
            script,
            "--input",
            input,
            "--authority",
            authority,
            "--key",
            key,
            "--output",
            output,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let text = "";
        child.stdout.on("data", (chunk) => {
          text += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          text += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, text }));
      });
    const first = await run();
    expect(first.code, first.text).toBe(0);
    expect(first.text).not.toContain("complete-雪-");
    const saved = await readFile(output, "utf8");
    expect(JSON.parse(saved).appId).toBe(f.appId);
    if (process.platform !== "win32")
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    const second = await run();
    expect(second.code).toBe(1);
    expect(second.text).not.toContain("complete-雪-");
    expect(await readFile(output, "utf8")).toBe(saved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
