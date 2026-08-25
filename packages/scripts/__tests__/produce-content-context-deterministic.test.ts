/** Exercises deterministic producer paging against real byte traversal boundaries without replacing its hash oracle. */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDeterministicTargetAdapter,
  traverseTarget,
} from "../lib/progressive-content-deterministic-helpers.mjs";

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("produce-content-context-deterministic", () => {
  it("accepts a zero-byte corpus object without inventing a page", async () => {
    const bytes = new Uint8Array();
    const object = {
      id: "zero-byte-file",
      revision: digest(bytes),
      sourceSha256: digest(bytes),
      byteLength: 0,
    };
    const read = vi.fn();

    await expect(
      traverseTarget({ object, read }, object),
    ).resolves.toMatchObject({
      rows: [],
      sourceWork: {
        objectId: object.id,
        bytesRead: 0,
        bytesReturned: 0,
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("caps mutant reads so continuation faults execute on micro objects", async () => {
    const bytes = Buffer.alloc(4096, 0x61);
    const object = {
      id: "micro-file",
      revision: digest(bytes),
      authorizationScope: "scope:micro-file",
    };
    const read = vi.fn(async ({ offset, limit }) => ({ offset, limit }));
    const target = {
      object,
      read,
      restart: vi.fn(),
      cleanup: vi.fn(),
    };
    const adapter = createDeterministicTargetAdapter(
      target,
      "micro-mutant",
      1024,
    );

    await expect(
      adapter.read({
        objectId: object.id,
        authorizationScope: object.authorizationScope,
        offset: 0,
        limit: 64 * 1024,
      }),
    ).resolves.toEqual({ offset: 0, limit: 1024 });
    expect(read).toHaveBeenCalledWith({
      access: "authorized",
      offset: 0,
      limit: 1024,
      expectedRevision: undefined,
    });
  });
});
