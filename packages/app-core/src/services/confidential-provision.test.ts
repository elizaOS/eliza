/** Exercises release admission and the real VMM HTTP boundary using loopback servers. */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { provisionConfidentialVm } from "./confidential-provision.ts";
import { signConfidentialRelease } from "./confidential-release.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}
const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicPem = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
function request(
  endpoint: string,
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
) {
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
    }),
    osImageHash: "a".repeat(64),
    variant: "dstack-tdx",
    notBefore: new Date(Date.now() - 120_000).toISOString(),
    expiresAt,
  };
  return {
    ...release,
    endpoint,
    envelope: signConfidentialRelease(release, privatePem),
    image: "approved-guest",
    vcpu: 2,
    memory: 4096,
    diskSize: 20,
    encryptedEnv: "aabbcc",
    kmsUrls: ["https://kms.example.test"],
  };
}

describe("confidential VM provisioning", () => {
  it("refuses a process-wide TLS verification bypass before dispatch", async () => {
    let calls = 0;
    const endpoint = await listen((_req, res) => {
      calls++;
      res.end("{}");
    });
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(
        provisionConfidentialVm(request(endpoint), publicPem),
      ).rejects.toMatchObject({
        code: "CONFIDENTIAL_TLS_VERIFICATION_REQUIRED",
      });
      expect(calls).toBe(0);
    } finally {
      if (previous === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });
  it("uses the real CLI to provision and emits a receipt without authorization bytes", async () => {
    let authorized = false;
    const secret = "Bearer synthetic-operator-token";
    const endpoint = await listen((req, res) => {
      authorized = req.headers.authorization === secret;
      res.end('{"id":"cfe8934a-d1be-4115-87ca-a7f1b379f390"}');
    });
    const directory = await mkdtemp(join(tmpdir(), "eliza-provision-cli-"));
    try {
      const inputPath = join(directory, "request.json");
      const authorityPath = join(directory, "authority.pem");
      await writeFile(inputPath, JSON.stringify(request(endpoint)));
      await writeFile(authorityPath, publicPem);
      const script = fileURLToPath(
        new URL("../../scripts/provision-confidential-vm.ts", import.meta.url),
      );
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          "bun",
          [script, "--input", inputPath, "--authority", authorityPath],
          {
            env: { ...process.env, DSTACK_VMM_AUTHORIZATION: secret },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0);
      expect(authorized).toBe(true);
      expect(JSON.parse(result.stdout)).toMatchObject({
        vmId: "cfe8934a-d1be-4115-87ca-a7f1b379f390",
        state: "created-stopped",
      });
      expect(result.stdout + result.stderr).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("sends complete measured bytes and encrypted environment to CreateVm, returning only a stopped receipt", async () => {
    const received: { path?: string; body?: Record<string, unknown> } = {};
    const endpoint = await listen(async (req, res) => {
      received.path = req.url;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.body = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ id: "ade8934a-d1be-4115-87ca-a7f1b379f390" }));
    });
    const input = request(endpoint);
    const receipt = await provisionConfidentialVm(input, publicPem);
    expect(receipt.state).toBe("created-stopped");
    expect(receipt.vmId).toBe("ade8934a-d1be-4115-87ca-a7f1b379f390");
    expect(received.path).toBe("/prpc/CreateVm?json");
    expect(received.body).toMatchObject({
      compose_file: input.compose,
      encrypted_env: input.encryptedEnv,
      app_id: receipt.appId,
      stopped: true,
      no_tee: false,
      ports: [],
    });
    expect(received.body).not.toHaveProperty("simulated_tee");
  });

  it("rejects changed bytes, expired authority and simulation before HTTP", async () => {
    let calls = 0;
    const endpoint = await listen((_req, res) => {
      calls++;
      res.end('{"id":"unexpected"}');
    });
    const input = request(endpoint);
    await expect(
      provisionConfidentialVm(
        { ...input, compose: `${input.compose}\n` },
        publicPem,
      ),
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_RELEASE_INVALID" });
    await expect(
      provisionConfidentialVm(
        request(endpoint, new Date(Date.now() - 1000).toISOString()),
        publicPem,
      ),
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_RELEASE_INVALID" });
    await expect(
      provisionConfidentialVm({ ...input, no_tee: true }, publicPem),
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_VM_REQUEST_INVALID" });
    expect(calls).toBe(0);
  });

  it.each(["redirect", "failure", "malformed", "oversize"])(
    "does not retry an ambiguous %s receipt",
    async (failure) => {
      let calls = 0;
      const endpoint = await listen((_req, res) => {
        calls++;
        if (failure === "redirect") {
          res.writeHead(302, { Location: "/elsewhere" });
          res.end();
        } else if (failure === "failure") {
          res.writeHead(500);
          res.end("private diagnostics");
        } else if (failure === "oversize") res.end("x".repeat(65_537));
        else res.end('{"ok":true}');
      });
      await expect(
        provisionConfidentialVm(request(endpoint), publicPem),
      ).rejects.toMatchObject({
        code: "CONFIDENTIAL_VM_PROVISION_UNCONFIRMED",
      });
      expect(calls).toBe(1);
    },
  );
});
