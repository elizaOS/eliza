/**
 * Coverage for the .eliza-agent archive writer: header magic, iteration and
 * salt/iv/tag framing, password policy, and AES-256-GCM round-trip via the
 * matching node built-ins.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildElizaAgentArchive,
  MIN_PASSWORD_LENGTH,
} from "./archive-format.js";

const MAGIC = Buffer.from("ELIZA_AGENT_V1\n", "utf-8");

function parseArchive(buffer: Buffer) {
  expect(buffer.subarray(0, MAGIC.length)).toEqual(MAGIC);
  const iterations = buffer.readUInt32BE(MAGIC.length);
  const salt = buffer.subarray(MAGIC.length + 4, MAGIC.length + 4 + 32);
  const iv = buffer.subarray(MAGIC.length + 4 + 32, MAGIC.length + 4 + 32 + 12);
  const tag = buffer.subarray(
    MAGIC.length + 4 + 32 + 12,
    MAGIC.length + 4 + 32 + 12 + 16,
  );
  const ciphertext = buffer.subarray(MAGIC.length + 4 + 32 + 12 + 16);
  return { ciphertext, iterations, iv, salt, tag };
}

describe("buildElizaAgentArchive", () => {
  it("rejects short or empty passwords", () => {
    const tooShort = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(() => buildElizaAgentArchive({}, tooShort)).toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`),
    );
    expect(() => buildElizaAgentArchive({}, "")).toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH}`),
    );
    expect(() =>
      buildElizaAgentArchive({}, "y".repeat(MIN_PASSWORD_LENGTH)),
    ).not.toThrow();
  });

  it("writes the V1 magic header and fixed framing", () => {
    const archive = buildElizaAgentArchive(
      { name: "eliza" },
      "correct-horse-battery",
    );
    const { iterations } = parseArchive(archive);
    expect(iterations).toBe(600_000);
  });

  it("round-trips the payload through gzip + AES-256-GCM", () => {
    const password = "correct-horse-battery";
    const payload = { name: "eliza", version: "1.0.0" };
    const archive = buildElizaAgentArchive(payload, password);
    const { ciphertext, iv, salt, tag } = parseArchive(archive);

    const key = pbkdf2Sync(password, salt, 600_000, 32, "sha256");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const json = gunzipSync(decrypted).toString("utf-8");
    expect(JSON.parse(json)).toEqual(payload);
  });

  it("produces distinct archives for the same payload (random salt/iv)", () => {
    const a = buildElizaAgentArchive({ x: 1 }, "correct-horse-battery");
    const b = buildElizaAgentArchive({ x: 1 }, "correct-horse-battery");
    expect(a.equals(b)).toBe(false);
  });
});
