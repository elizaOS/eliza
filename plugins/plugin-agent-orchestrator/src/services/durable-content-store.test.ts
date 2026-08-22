/**
 * Durable orchestrator content is exercised against a real temporary store,
 * including credential masking and lossless UTF-8 continuation boundaries.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  durableProjection,
  readDurableContent,
} from "./durable-content-store.js";

let trajectoryDir: string;
let previousTrajectoryDir: string | undefined;

beforeEach(() => {
  trajectoryDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-content-"),
  );
  previousTrajectoryDir = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
});

afterEach(() => {
  if (previousTrajectoryDir === undefined) {
    delete process.env.ELIZA_TRAJECTORY_DIR;
  } else {
    process.env.ELIZA_TRAJECTORY_DIR = previousTrajectoryDir;
  }
  fs.rmSync(trajectoryDir, { recursive: true, force: true });
});

describe("durable orchestrator content", () => {
  it("keeps the projected view, stored bytes, and source hash consistent after redaction", () => {
    const full = `Authorization: Bearer ${"secret-token-".repeat(20)}\n${"x".repeat(500)}`;
    const projection = durableProjection(full, 180);
    const sha = projection.reference?.ref.slice("acpx-content:".length) ?? "";
    const stored = readDurableContent(sha, { limit: 1_048_576 });

    expect(projection.truncated).toBe(true);
    expect(stored?.text).not.toContain("secret-token-");
    expect(projection.view).not.toContain("secret-token-");
    expect(projection.read?.slice.sourceSha256).toBe(sha);
    expect(projection.read?.slice.range.total).toBe(stored?.totalBytes);
  });

  it("reassembles multibyte text losslessly with byte-sized windows", () => {
    const full = "🙂é漢字".repeat(100);
    const projection = durableProjection(full, 20);
    const sha = projection.reference?.ref.slice("acpx-content:".length) ?? "";
    let offset = 0;
    let reassembled = "";

    for (;;) {
      const window = readDurableContent(sha, { offset, limit: 1 });
      if (!window) throw new Error("durable content disappeared");
      reassembled += window.text;
      if (!window.hasMore) break;
      expect(window.endOffset).toBeGreaterThan(offset);
      offset = window.endOffset;
    }

    expect(reassembled).toBe(full);
    expect(reassembled).not.toContain("�");
  });

  it("normalizes a caller offset inside a UTF-8 code point", () => {
    const projection = durableProjection("🙂abc".repeat(100), 10);
    const sha = projection.reference?.ref.slice("acpx-content:".length) ?? "";
    const window = readDurableContent(sha, { offset: 1, limit: 4 });

    expect(window?.offset).toBe(4);
    expect(window?.text).toBe("abc");
  });
});
