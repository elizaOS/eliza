/**
 * Consumes the trusted live-model credential and receipt-attestation key from
 * a bounded inherited pipe before any Cloud stack or scenario child starts.
 */

import { once } from "node:events";
import { createReadStream } from "node:fs";

export const REAL_MODEL_BOOTSTRAP_FD = 3;
export const MAX_REAL_MODEL_BOOTSTRAP_BYTES = 128 * 1024;

export type RealModelBootstrap = {
  credentialEnvironment: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";
  credentialValue: string;
  meterAttestationKey: string;
};

export async function readRealModelBootstrap(
  descriptor = REAL_MODEL_BOOTSTRAP_FD,
): Promise<RealModelBootstrap> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = createReadStream("", {
    fd: descriptor,
    autoClose: true,
    highWaterMark: 16 * 1024,
  });
  const closed = once(stream, "close");
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (value: Buffer | string) => {
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > MAX_REAL_MODEL_BOOTSTRAP_BYTES) {
          stream.pause();
          reject(new Error("real-model bootstrap exceeds its byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("end", resolve);
      stream.once("error", reject);
    });
  } finally {
    if (!stream.closed) stream.destroy();
    await closed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch (cause) {
    // error-policy:J3 the trusted boundary rejects malformed bootstrap input.
    throw new Error("real-model bootstrap must be valid JSON", { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("real-model bootstrap must be an object");
  }
  const bootstrap = parsed as Record<string, unknown>;
  if (
    Object.keys(bootstrap).length !== 4 ||
    bootstrap.version !== 1 ||
    (bootstrap.credentialEnvironment !== "OPENAI_API_KEY" &&
      bootstrap.credentialEnvironment !== "ANTHROPIC_API_KEY") ||
    typeof bootstrap.credentialValue !== "string" ||
    bootstrap.credentialValue.trim().length === 0 ||
    Buffer.byteLength(bootstrap.credentialValue) > 64 * 1024 ||
    typeof bootstrap.meterAttestationKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(bootstrap.meterAttestationKey)
  ) {
    throw new Error("real-model bootstrap has an invalid schema");
  }
  return bootstrap as RealModelBootstrap;
}
