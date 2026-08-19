/**
 * Deterministic overflow coverage for the first-run POST body reader.
 * The harness is a real Readable stream (no network). Origin concatenated
 * every chunk before JSON.parse; a body over the cap must reject first.
 */

import { describe, expect, it } from "bun:test";
import type http from "node:http";
import { Readable } from "node:stream";
import {
  FirstRunBodyTooLargeError,
  MAX_FIRST_RUN_BODY_BYTES,
  readFirstRunRawBody,
} from "./first-run-routes-body.ts";

function bodyStream(raw: string): http.IncomingMessage {
  return Readable.from([
    Buffer.from(raw, "utf8"),
  ]) as unknown as http.IncomingMessage;
}

describe("readFirstRunRawBody", () => {
  it("admits a small object body", async () => {
    const raw = await readFirstRunRawBody(bodyStream('{"name":"Eliza"}'));
    expect(raw).toBe('{"name":"Eliza"}');
  });

  it("rejects a body past the cap before concat of the full stream", async () => {
    const overflow = "x".repeat(128);
    await expect(
      readFirstRunRawBody(bodyStream(overflow), 64),
    ).rejects.toBeInstanceOf(FirstRunBodyTooLargeError);
  });

  it("keeps the production cap at 1 MiB", () => {
    expect(MAX_FIRST_RUN_BODY_BYTES).toBe(1_048_576);
  });
});
