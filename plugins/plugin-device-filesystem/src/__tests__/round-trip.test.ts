import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeviceFilesystemBridge } from "../services/device-filesystem-bridge.js";

describe("DeviceFilesystemBridge round-trip (Node backend)", () => {
  let tempRoot: string;
  let bridge: DeviceFilesystemBridge;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "device-fs-rt-"));
    bridge = DeviceFilesystemBridge.forNodeRoot(tempRoot);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes a file and reads it back", async () => {
    await bridge.write("notes.txt", "hello world");
    const got = await bridge.read("notes.txt");
    expect(got).toBe("hello world");
  });

  it("lists files at the root after a write", async () => {
    await bridge.write("alpha.txt", "a");
    await bridge.write("beta.txt", "b");
    const entries = await bridge.list("");
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("alpha.txt");
    expect(names).toContain("beta.txt");
    expect(entries.every((e) => e.type === "file")).toBe(true);
  });

  it("lists nested directories with correct type", async () => {
    await bridge.write("docs/readme.md", "# hi");
    const root = await bridge.list("");
    const docs = root.find((e) => e.name === "docs");
    expect(docs).toBeDefined();
    expect(docs?.type).toBe("directory");
    const inside = await bridge.list("docs");
    expect(inside).toEqual([{ name: "readme.md", type: "file" }]);
  });

  it("overwrites an existing file", async () => {
    await bridge.write("config.json", "{}");
    await bridge.write("config.json", "{\"k\": 1}");
    expect(await bridge.read("config.json")).toBe("{\"k\": 1}");
  });
});
