/** Real filesystem proof survives FILE dispatch and excludes failed mutations. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileEffectReceipt } from "../lib/file-effect-receipt.js";
import { setupEnv, type TestEnv } from "./__tests__/helpers.js";
import { fileAction } from "./file.js";

const version = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("FILE mutation receipts", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv("file-receipts");
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it.each([
    ["plain", "none"],
    ["plain\n", "LF"],
    ["plain\r\n", "CRLF"],
    ["plain\r", "CR"],
    ["", "none"],
    ["猫🙂  \n", "LF"],
    ["plain\n ", "none"],
  ])(
    "exposes exact whole-file line ending for %j without changing bytes",
    async (content, ending) => {
      const file = path.join(env.tmpDir, "ending.txt");
      const run = (parameters: Record<string, unknown>) =>
        fileAction.handler(env.runtime, env.message, undefined, {
          parameters: { file_path: file, ...parameters },
        });
      const written = await run({ action: "write", content });
      expect(written.success).toBe(true);
      expect(written.data?.finalLineEnding).toBe(ending);
      expect(await fs.readFile(file)).toEqual(Buffer.from(content));
      expect(written.effectReceipts?.[0].resource.version).toBe(
        version(Buffer.from(content)),
      );
      const read = await run({ action: "read" });
      expect(read.success).toBe(true);
      expect(read.text).toBe(content);
      expect(read.data?.finalLineEnding).toBe(ending);
      if (content) {
        const updated = "replacement 🙂\r\n";
        const edited = await run({
          action: "edit",
          old_string: content,
          new_string: updated,
        });
        expect(edited.success).toBe(true);
        expect(edited.data?.finalLineEnding).toBe("CRLF");
        expect(await fs.readFile(file)).toEqual(Buffer.from(updated));
        expect(edited.effectReceipts?.[0].resource.version).toBe(
          version(Buffer.from(updated)),
        );
      }
    },
  );

  it("omits whole-file line-ending metadata for partial reads, including an EOF suffix", async () => {
    const file = path.join(env.tmpDir, "slice.txt");
    await fs.writeFile(file, "a\nb\r\n");
    const run = (parameters: Record<string, unknown>) =>
      fileAction.handler(env.runtime, env.message, undefined, {
        parameters: {
          action: "read",
          file_path: file,
          unit: "byte",
          ...parameters,
        },
      });
    const complete = await run({});
    expect(complete.success).toBe(true);
    expect(complete.data?.finalLineEnding).toBe("CRLF");
    const view = complete.data?.readView as { reference: { revision: string } };
    for (const [offset, limit, expected] of [
      [0, 2, "a\n"],
      [2, 3, "b\r\n"],
    ] as const) {
      const slice = await run({
        offset,
        limit,
        expectedRevision: view.reference.revision,
      });
      expect(slice.success).toBe(true);
      expect(slice.text).toBe(expected);
      expect(slice.data).not.toHaveProperty("finalLineEnding");
    }
  });

  it("preserves byte-exact write and edit receipts through the umbrella", async () => {
    const file = path.join(env.tmpDir, "unicode.html");
    const callback = vi.fn(async () => []);
    const content = "<p>héllo 🌱</p>\r\n";
    const written = await fileAction.handler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { action: "write", file_path: file, content },
      },
      callback,
    );
    expect(written.success).toBe(true);
    expect(await fs.readFile(file)).toEqual(Buffer.from(content));
    expect(written.effectReceipts).toHaveLength(1);
    expect(written.effectReceipts?.[0]).toMatchObject({
      operation: "filesystem.write",
      outcome: "applied",
      resource: {
        kind: "filesystem.file",
        id: file,
        version: version(await fs.readFile(file)),
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      commit: {
        kind: "durable",
        id: `${file}#${version(await fs.readFile(file))}`,
      },
    });
    expect(written.userFacingEffectReceiptIds).toEqual([
      written.effectReceipts?.[0].receiptId,
    ]);
    expect(callback).toHaveBeenCalledTimes(1);
    await env.fileState.recordRead("test-room", file);
    const edited = await fileAction.handler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          action: "edit",
          file_path: file,
          old_string: "héllo",
          new_string: "bonjour",
        },
      },
    );
    expect(edited.success).toBe(true);
    expect(await fs.readFile(file)).toEqual(
      Buffer.from(content.replace("héllo", "bonjour")),
    );
    expect(edited.effectReceipts?.[0]).toMatchObject({
      operation: "filesystem.edit",
      outcome: "applied",
      resource: { id: file, version: version(await fs.readFile(file)) },
      commit: { kind: "durable" },
    });
    expect(edited.effectReceipts?.[0].receiptId).not.toBe(
      written.effectReceipts?.[0].receiptId,
    );
    expect(edited.effectReceipts?.[0].resource.version).not.toBe(
      written.effectReceipts?.[0].resource.version,
    );
  });

  it.each(["write", "edit"])(
    "preserves the committed %s if confirmation delivery rejects",
    async (action) => {
      const file = path.join(env.tmpDir, "delivered.txt");
      if (action === "edit") {
        await fs.writeFile(file, "old");
        await env.fileState.recordRead("test-room", file);
      }
      const reportError = vi.fn();
      env.runtime.reportError = reportError;
      const callback = vi.fn(async () => {
        throw new Error("transport disconnected");
      });
      const result = await fileAction.handler(
        env.runtime,
        env.message,
        undefined,
        {
          parameters: {
            action,
            file_path: file,
            content: "new",
            old_string: "old",
            new_string: "new",
          },
        },
        callback,
      );
      expect(await fs.readFile(file, "utf8")).toBe("new");
      expect(result.success).toBe(true);
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "applied",
        operation: `filesystem.${action}`,
        resource: { id: file, version: version(Buffer.from("new")) },
      });
      expect(result.replyFailure).toMatchObject({
        code: "FILE_CONFIRMATION_DELIVERY_FAILED",
        transient: false,
      });
      expect(result.userFacingText).toBeUndefined();
      expect(result.turnComplete).toBeUndefined();
      expect(result.data).toMatchObject({
        confirmationDeliveryError: "transport disconnected",
        finalLineEnding: "none",
      });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledTimes(1);
    },
  );

  it("retains actual commit proof when subsequent file-state bookkeeping fails", async () => {
    const file = path.join(env.tmpDir, "tracking.txt");
    vi.spyOn(env.fileState, "recordWrite").mockRejectedValueOnce(
      new Error("stat unavailable"),
    );
    const callback = vi.fn(async () => []);
    const result = await fileAction.handler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { action: "write", file_path: file, content: "committed" },
      },
      callback,
    );
    expect(result.success).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("committed");
    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: { version: version(Buffer.from("committed")) },
    });
    expect(result.text).toContain("file-state tracking failed");
    expect(result.failureProvenance).toMatchObject({
      code: "FILE_STATE_TRACKING_FAILED",
      retryable: false,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not emit success or applied receipts when the filesystem write fails", async () => {
    const parent = path.join(env.tmpDir, "not-a-directory");
    await fs.writeFile(parent, "keep");
    const callback = vi.fn(async () => []);
    const result = await fileAction.handler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          action: "write",
          file_path: path.join(parent, "file.txt"),
          content: "new",
        },
      },
      callback,
    );
    expect(result.success).toBe(false);
    expect(result.effectReceipts).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(await fs.readFile(parent, "utf8")).toBe("keep");
  });

  it("refuses local commit proof for missing or changed bytes", async () => {
    const file = path.join(env.tmpDir, "changed.txt");
    await fs.writeFile(file, "changed");
    await expect(
      fileEffectReceipt({
        path: file,
        content: "expected",
        operation: "write",
      }),
    ).rejects.toMatchObject({ code: "FILE_WRITE_UNVERIFIED" });
    await fs.unlink(file);
    await expect(
      fileEffectReceipt({ path: file, content: "expected", operation: "edit" }),
    ).rejects.toThrow();
  });

  it("distinguishes provider acceptance from local durability and rejects partial acceptance", async () => {
    const file = path.join(env.tmpDir, "remote.txt");
    const content = "é";
    const receipt = await fileEffectReceipt({
      path: file,
      content,
      operation: "write",
      acceptedBytes: 2,
    });
    expect(receipt.commit.kind).toBe("provider_accepted");
    expect(receipt.resource.version).toBe(version(Buffer.from(content)));
    await expect(fs.stat(file)).rejects.toThrow();
    await expect(
      fileEffectReceipt({
        path: file,
        content,
        operation: "write",
        acceptedBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "FILE_WRITE_UNVERIFIED" });
  });
});
