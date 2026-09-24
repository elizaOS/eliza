/** Exercises the real filesystem-backed native-enrollment replay boundary. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserBridgeNativeProtocolError } from "./browser-bridge-native-protocol";
import { PersistentNativeEnrollmentReplayGuard } from "./browser-bridge-replay-store";

const directories: string[] = [];

function replayPath(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-browser-replay-"),
  );
  directories.push(directory);
  return path.join(directory, "browser-bridge", "enrollment-replay.json");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PersistentNativeEnrollmentReplayGuard", () => {
  it("rejects the same nonce after broker recreation without persisting it in plaintext", () => {
    const filePath = replayPath();
    const key = crypto.randomBytes(32);
    new PersistentNativeEnrollmentReplayGuard(filePath, key).consume(
      "restart-sensitive-nonce",
      1_000,
    );

    expect(fs.readFileSync(filePath, "utf8")).not.toContain(
      "restart-sensitive-nonce",
    );
    expect(() =>
      new PersistentNativeEnrollmentReplayGuard(filePath, key).consume(
        "restart-sensitive-nonce",
        1_001,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<BrowserBridgeNativeProtocolError>>({
        code: "replayed_nonce",
      }),
    );
  }, 20_000);

  it("serializes consumes from distinct broker guards against the same store", () => {
    const filePath = replayPath();
    const key = crypto.randomBytes(32);
    const first = new PersistentNativeEnrollmentReplayGuard(filePath, key);
    const second = new PersistentNativeEnrollmentReplayGuard(filePath, key);

    first.consume("shared-nonce", 2_000);
    expect(() => second.consume("shared-nonce", 2_000)).toThrowError(
      expect.objectContaining<Partial<BrowserBridgeNativeProtocolError>>({
        code: "replayed_nonce",
      }),
    );
  }, 20_000);

  it("fails closed when the persisted replay document is corrupt", () => {
    const filePath = replayPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "not-json", { mode: 0o600 });

    expect(() =>
      new PersistentNativeEnrollmentReplayGuard(
        filePath,
        crypto.randomBytes(32),
      ).consume("nonce", 3_000),
    ).toThrowError(
      expect.objectContaining<Partial<BrowserBridgeNativeProtocolError>>({
        code: "replay_store_corrupt",
      }),
    );
  }, 20_000);

  it("prunes expired entries before enforcing capacity", () => {
    const filePath = replayPath();
    const key = crypto.randomBytes(32);
    const guard = new PersistentNativeEnrollmentReplayGuard(
      filePath,
      key,
      10,
      1,
    );
    guard.consume("expired", 4_000);
    guard.consume("replacement", 4_010);

    expect(() => guard.consume("overflow", 4_010)).toThrowError(
      expect.objectContaining<Partial<BrowserBridgeNativeProtocolError>>({
        code: "replay_capacity_exceeded",
      }),
    );
  }, 20_000);
});
