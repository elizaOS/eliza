import type { IAgentRuntime, Memory, Service } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { fileAction } from "./file.js";

interface FakeDeviceBridge extends Service {
  read(path: string, encoding?: "utf8" | "base64"): Promise<string>;
  write(
    path: string,
    content: string,
    encoding?: "utf8" | "base64",
  ): Promise<void>;
  list(path: string): Promise<{ name: string; type: "file" | "directory" }[]>;
}

function buildRuntime(bridge: FakeDeviceBridge): IAgentRuntime {
  return {
    getService: (serviceType: string) =>
      serviceType === "device_filesystem" ? bridge : null,
    getSetting: () => undefined,
  } as IAgentRuntime;
}

describe("FILE target=device", () => {
  const message = { roomId: "test-room" } as Memory;

  it("routes reads through the device filesystem bridge", async () => {
    const bridge = {
      read: async (path: string, encoding?: "utf8" | "base64") =>
        `${path}:${encoding}`,
      write: async () => {},
      list: async () => [],
    } as FakeDeviceBridge;

    const result = await fileAction.handler(
      buildRuntime(bridge),
      message,
      undefined,
      { parameters: { action: "read", target: "device", path: "notes.txt" } },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Read");
    expect(result.data).toMatchObject({
      action: "FILE",
      target: "device",
      operation: "read",
      path: "notes.txt",
      encoding: "utf8",
      content: "notes.txt:utf8",
    });
  });

  it("routes writes through the device filesystem bridge", async () => {
    const writes: unknown[] = [];
    const bridge = {
      read: async () => "",
      write: async (
        path: string,
        content: string,
        encoding?: "utf8" | "base64",
      ) => {
        writes.push({ path, content, encoding });
      },
      list: async () => [],
    } as FakeDeviceBridge;

    const result = await fileAction.handler(
      buildRuntime(bridge),
      message,
      undefined,
      {
        parameters: {
          action: "write",
          scope: "device",
          file_path: "docs/out.txt",
          content: "hello",
          encoding: "utf8",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(writes).toEqual([
      { path: "docs/out.txt", content: "hello", encoding: "utf8" },
    ]);
    expect(result.data).toMatchObject({
      action: "FILE",
      target: "device",
      operation: "write",
      path: "docs/out.txt",
      bytes: 5,
    });
  });

  it("routes directory listing through FILE action=ls target=device", async () => {
    const bridge = {
      read: async () => "",
      write: async () => {},
      list: async (path: string) => [
        { name: `${path || "root"}.txt`, type: "file" as const },
        { name: "docs", type: "directory" as const },
      ],
    } as FakeDeviceBridge;

    const result = await fileAction.handler(
      buildRuntime(bridge),
      message,
      undefined,
      { parameters: { action: "ls", target: "device", path: "" } },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("docs/");
    expect(result.text).toContain("root.txt");
    expect(result.data).toMatchObject({
      action: "FILE",
      target: "device",
      operation: "ls",
      path: "",
    });
  });

  it("rejects unsupported device operations", async () => {
    const bridge = {
      read: async () => "",
      write: async () => {},
      list: async () => [],
    } as FakeDeviceBridge;

    const result = await fileAction.handler(
      buildRuntime(bridge),
      message,
      undefined,
      { parameters: { action: "grep", target: "device", pattern: "x" } },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain(
      "target=device supports action=read/write/ls",
    );
  });
});
