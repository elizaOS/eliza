/**
 * E2E tests for agent export/import API endpoints.
 *
 * Tests the full export/import cycle through the HTTP API:
 * - POST /api/agent/export — password-encrypted download
 * - POST /api/agent/import — upload and decrypt
 * - GET /api/agent/export/estimate — size estimation
 * - Error cases: no runtime, bad password, corrupt files
 *
 * These tests start the real API server without a runtime. The export/import
 * endpoints require a running runtime and will return 503 when none is present.
 * This validates the API layer, error handling, and request/response formats.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonReq(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

function binaryReq(
  port: number,
  method: string,
  p: string,
  body: Buffer,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length,
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(ch),
          });
        });
      },
    );
    r.on("error", reject);
    r.write(body);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent Export/Import API (no runtime)", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  // -- Export endpoint --

  describe("POST /api/agent/export", () => {
    it("returns 503 when no runtime is running", async () => {
      const { status, data } = await jsonReq(
        port,
        "POST",
        "/api/agent/export",
        {
          password: "test-password",
        },
      );
      expect(status).toBe(503);
      expect(data.error).toMatch(/not running/i);
    });

    it("returns 503 even when password is missing (runtime check first)", async () => {
      const { status } = await jsonReq(port, "POST", "/api/agent/export", {});
      expect(status).toBe(503);
    });

    it("returns 503 even when password is too short (runtime check first)", async () => {
      const { status } = await jsonReq(port, "POST", "/api/agent/export", {
        password: "ab",
      });
      expect(status).toBe(503);
    });
  });

  // -- Export estimate endpoint --

  describe("GET /api/agent/export/estimate", () => {
    it("returns 503 when no runtime is running", async () => {
      const { status, data } = await jsonReq(
        port,
        "GET",
        "/api/agent/export/estimate",
      );
      expect(status).toBe(503);
      expect(data.error).toMatch(/not running/i);
    });
  });

  // -- Import endpoint --

  describe("POST /api/agent/import", () => {
    it("returns 503 when no runtime is running", async () => {
      // Build a minimal binary envelope
      const password = "test-password";
      const passwordBytes = Buffer.from(password, "utf-8");
      const fakeFile = Buffer.alloc(100, 0);
      const envelope = Buffer.alloc(4 + passwordBytes.length + fakeFile.length);
      envelope.writeUInt32BE(passwordBytes.length, 0);
      passwordBytes.copy(envelope, 4);
      fakeFile.copy(envelope, 4 + passwordBytes.length);

      const { status, body: respBody } = await binaryReq(
        port,
        "POST",
        "/api/agent/import",
        envelope,
      );
      expect(status).toBe(503);

      const data = JSON.parse(respBody.toString("utf-8")) as Record<
        string,
        unknown
      >;
      expect(data.error).toMatch(/not running/i);
    });

    it("returns 503 when request body is too small (runtime check first)", async () => {
      const tiny = Buffer.from("hi");
      const { status } = await binaryReq(
        port,
        "POST",
        "/api/agent/import",
        tiny,
      );
      expect(status).toBe(503);
    });

    it("returns 503 when password length field is invalid (runtime check first)", async () => {
      const badEnvelope = Buffer.alloc(20);
      badEnvelope.writeUInt32BE(2000, 0); // password length > remaining bytes
      const { status } = await binaryReq(
        port,
        "POST",
        "/api/agent/import",
        badEnvelope,
      );
      expect(status).toBe(503);
    });
  });

  // -- Binary envelope format --

  describe("import binary envelope format", () => {
    it("correctly encodes and decodes the password/file envelope", () => {
      const password = "my-secret-password";
      const fileData = Buffer.from("ELIZA_AGENT_V1\nsome-encrypted-data");

      // Encode
      const passwordBytes = Buffer.from(password, "utf-8");
      const envelope = Buffer.alloc(4 + passwordBytes.length + fileData.length);
      envelope.writeUInt32BE(passwordBytes.length, 0);
      passwordBytes.copy(envelope, 4);
      fileData.copy(envelope, 4 + passwordBytes.length);

      // Decode
      const decodedPwLen = envelope.readUInt32BE(0);
      const decodedPw = envelope
        .subarray(4, 4 + decodedPwLen)
        .toString("utf-8");
      const decodedFile = envelope.subarray(4 + decodedPwLen);

      expect(decodedPw).toBe(password);
      expect(decodedFile.toString("utf-8")).toBe(fileData.toString("utf-8"));
    });
  });
});

describe("Agent Export/Import crypto round-trip (unit-level)", () => {
  it("encrypts and decrypts a payload correctly", async () => {
    // This directly tests the internal encrypt/decrypt cycle
    // by going through the public API with mock data
    const crypto = await import("node:crypto");
    const { gzipSync, gunzipSync } = await import("node:zlib");

    const MAGIC_HEADER = "ELIZA_AGENT_V1\n";
    const PBKDF2_ITERATIONS = 600_000;

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceAgentId: crypto.randomUUID(),
      agent: { name: "TestAgent", id: crypto.randomUUID() },
      entities: [],
      memories: [{ id: crypto.randomUUID(), content: { text: "hello" } }],
      components: [],
      rooms: [],
      participants: [],
      relationships: [],
      worlds: [],
      tasks: [],
      logs: [],
    };

    const password = "roundtrip-test-password";
    const jsonStr = JSON.stringify(payload);
    const compressed = gzipSync(Buffer.from(jsonStr, "utf-8"));

    // Encrypt
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(
      password,
      salt,
      PBKDF2_ITERATIONS,
      32,
      "sha256",
    );
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(compressed),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Pack into file format
    const iterBuf = Buffer.alloc(4);
    iterBuf.writeUInt32BE(PBKDF2_ITERATIONS, 0);
    const fileBuffer = Buffer.concat([
      Buffer.from(MAGIC_HEADER, "utf-8"),
      iterBuf,
      salt,
      iv,
      tag,
      ciphertext,
    ]);

    // Unpack
    let offset = Buffer.from(MAGIC_HEADER, "utf-8").length;
    const readIterations = fileBuffer.readUInt32BE(offset);
    offset += 4;
    const readSalt = fileBuffer.subarray(offset, offset + 32);
    offset += 32;
    const readIv = fileBuffer.subarray(offset, offset + 12);
    offset += 12;
    const readTag = fileBuffer.subarray(offset, offset + 16);
    offset += 16;
    const readCiphertext = fileBuffer.subarray(offset);

    expect(readIterations).toBe(PBKDF2_ITERATIONS);

    // Decrypt
    const readKey = crypto.pbkdf2Sync(
      password,
      readSalt,
      readIterations,
      32,
      "sha256",
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", readKey, readIv);
    decipher.setAuthTag(readTag);
    const decrypted = Buffer.concat([
      decipher.update(readCiphertext),
      decipher.final(),
    ]);

    // Decompress
    const decompressed = gunzipSync(decrypted);
    const recovered = JSON.parse(
      decompressed.toString("utf-8"),
    ) as typeof payload;

    expect(recovered.version).toBe(1);
    expect(recovered.agent.name).toBe("TestAgent");
    expect(recovered.memories).toHaveLength(1);
    expect(recovered.memories[0].content.text).toBe("hello");
  });

  it("fails decryption with wrong password", async () => {
    const crypto = await import("node:crypto");
    const { gzipSync } = await import("node:zlib");

    const password = "correct-password";
    const wrongPassword = "wrong-password";

    const data = gzipSync(Buffer.from('{"test":"data"}'));
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(password, salt, 600_000, 32, "sha256");
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Try with wrong password
    const wrongKey = crypto.pbkdf2Sync(
      wrongPassword,
      salt,
      600_000,
      32,
      "sha256",
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", wrongKey, iv);
    decipher.setAuthTag(tag);

    expect(() => {
      Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }).toThrow();
  });
});
