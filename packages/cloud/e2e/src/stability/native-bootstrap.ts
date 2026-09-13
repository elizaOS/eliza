/**
 * Consumes public native-admission context from the outer adapter's dedicated
 * pipe before the trusted attempt starts services or any scenario process.
 */
import { once } from "node:events";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { NativeExpectedContext } from "./native-attestation-channel.ts";

export interface NativeBootstrap {
  version: 1;
  nativeBundle: string;
  ownerScript: string;
  request: {
    nonce: string;
    context: NativeExpectedContext;
    adapterIdentity: { pid: number; uid: number; startTicks: number };
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native bootstrap requires an object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join("\0") !== keys.sort().join("\0"))
    throw new Error("Native bootstrap fields differ from its protocol");
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Native process identity is invalid");
  return value;
}
function authorityPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  )
    throw new Error("Native authority path is not canonical");
  return value;
}
export async function readNativeBootstrap(
  descriptor = 4,
): Promise<NativeBootstrap> {
  const stream = createReadStream("", {
    fd: descriptor,
    autoClose: true,
    highWaterMark: 16384,
  });
  const closed = once(stream, "close");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (value: Buffer | string) => {
        const bytes = Buffer.from(value);
        size += bytes.length;
        if (size > 65536) {
          stream.pause();
          reject(new Error("Native bootstrap exceeds its protocol boundary"));
          return;
        }
        chunks.push(bytes);
      });
      stream.once("end", resolve);
      stream.once("error", reject);
    });
  } finally {
    if (!stream.closed) stream.destroy();
    await closed;
  }
  const value = record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    ),
  );
  exact(value, ["version", "nativeBundle", "ownerScript", "request"]);
  if (value.version !== 1)
    throw new Error("Native bootstrap version is unsupported");
  const request = record(value.request);
  exact(request, ["nonce", "context", "adapterIdentity"]);
  if (
    typeof request.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(request.nonce)
  )
    throw new Error("Native nonce is invalid");
  const identity = record(request.adapterIdentity);
  exact(identity, ["pid", "uid", "startTicks"]);
  const context: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(record(request.context))) {
    if (
      (typeof item !== "string" && typeof item !== "number") ||
      (typeof item === "number" && !Number.isSafeInteger(item))
    )
      throw new Error("Native context field is invalid");
    context[key] = item;
  }
  return {
    version: 1,
    nativeBundle: authorityPath(value.nativeBundle),
    ownerScript: authorityPath(value.ownerScript),
    request: {
      nonce: request.nonce,
      context,
      adapterIdentity: {
        pid: positive(identity.pid),
        uid: positive(identity.uid),
        startTicks: positive(identity.startTicks),
      },
    },
  };
}
