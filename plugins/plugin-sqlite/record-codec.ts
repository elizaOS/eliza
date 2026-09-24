/**
 * Encodes portable database records with an explicitly versioned, pinned codec.
 * No runtime-specific clone format or executable JavaScript is accepted here.
 * Unsupported values fail before a write; Buffer reducers retain visible bytes.
 */
import { ElizaError } from "@elizaos/core";
import { parse, stringify } from "devalue";

export const RECORD_CODEC = "devalue-6.0.1-buffer-v1";
const decoder = new TextDecoder("utf-8", { fatal: true });
const prefix = Buffer.from(`eliza-record:${RECORD_CODEC}\n`, "utf8");

export function encodeRecord(value: unknown): Uint8Array {
  try {
    const text = stringify(value, {
      Buffer: (entry: unknown) =>
        Buffer.isBuffer(entry) && [entry.toString("base64")],
    });
    return Buffer.concat([prefix, Buffer.from(text, "utf8")]);
  } catch (cause) {
    // error-policy:J2 Reject unsupported records before persisting any partial value.
    throw new ElizaError(
      "Record contains a value unsupported by the portable SQLite codec",
      {
        code: "SQLITE_RECORD_ENCODING_UNSUPPORTED",
        cause,
      },
    );
  }
}

export function decodeRecord(bytes: Uint8Array): unknown {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, prefix.length).equals(prefix)) {
    throw new ElizaError(
      "Record codec is unknown; use a compatible database migration",
      {
        code: "SQLITE_RECORD_CODEC_UNSUPPORTED",
      },
    );
  }
  try {
    return parse(decoder.decode(buffer.subarray(prefix.length)), {
      Buffer: (value: unknown) => {
        if (
          !Array.isArray(value) ||
          value.length !== 1 ||
          typeof value[0] !== "string"
        ) {
          throw new Error("Invalid portable Buffer record");
        }
        const result = Buffer.from(value[0], "base64");
        if (result.toString("base64") !== value[0])
          throw new Error("Invalid Buffer encoding");
        return result;
      },
    });
  } catch (cause) {
    // error-policy:J2 Corrupt persisted data is an explicit read failure.
    throw new ElizaError("Portable SQLite record cannot be decoded", {
      code: "SQLITE_RECORD_INVALID",
      cause,
    });
  }
}
