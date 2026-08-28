import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeFullDiskAccess } from "./fda-probe.js";

const realPlatform = process.platform;
const realEnv = { ...process.env };

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  setPlatform("darwin");
  delete process.env.IMESSAGE_DB_PATH;
});

afterEach(() => {
  setPlatform(realPlatform);
  process.env = { ...realEnv };
});

describe("probeFullDiskAccess", () => {
  it("is not applicable on non-darwin platforms", async () => {
    setPlatform("linux");
    const result = await probeFullDiskAccess();
    expect(result.status).toBe("not_applicable");
    expect(result.reason).toContain("macOS");
  });

  it("reports granted when the chat.db file opens", async () => {
    const fs = await import("node:fs");
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockResolvedValue({ close: vi.fn(async () => {}) } as never);
    try {
      const result = await probeFullDiskAccess({ chatDbPath: "/tmp/chat.db" });
      expect(result.status).toBe("granted");
      expect(result.chatDbPath).toBe("/tmp/chat.db");
      expect(result.reason).toBeNull();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reports not_applicable when the file is missing (ENOENT)", async () => {
    const fs = await import("node:fs");
    const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const openSpy = vi.spyOn(fs.promises, "open").mockRejectedValue(error);
    try {
      const result = await probeFullDiskAccess({
        chatDbPath: "/tmp/missing.db",
      });
      expect(result.status).toBe("not_applicable");
      expect(result.reason).toContain("not present");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reports revoked on EPERM/EACCES", async () => {
    const fs = await import("node:fs");
    const error = Object.assign(new Error("permission denied"), {
      code: "EPERM",
    });
    const openSpy = vi.spyOn(fs.promises, "open").mockRejectedValue(error);
    try {
      const result = await probeFullDiskAccess({
        chatDbPath: "/tmp/denied.db",
      });
      expect(result.status).toBe("revoked");
      expect(result.reason).toContain("Full Disk Access");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reports unknown for unclassified errno errors", async () => {
    const fs = await import("node:fs");
    const error = Object.assign(new Error("disk on fire"), { code: "EIO" });
    const openSpy = vi.spyOn(fs.promises, "open").mockRejectedValue(error);
    try {
      const result = await probeFullDiskAccess({ chatDbPath: "/tmp/eio.db" });
      expect(result.status).toBe("unknown");
      expect(result.reason).toContain("EIO");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("falls back to the default path when IMESSAGE_DB_PATH is an empty string", async () => {
    process.env.IMESSAGE_DB_PATH = "   ";
    const fs = await import("node:fs");
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockResolvedValue({ close: vi.fn(async () => {}) } as never);
    try {
      const result = await probeFullDiskAccess();
      // A blank env override must not make us open an empty path — the
      // default chat.db location is probed instead.
      expect(result.chatDbPath.length).toBeGreaterThan(0);
      expect(result.status).toBe("granted");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("prefers an explicit override over the environment variable", async () => {
    process.env.IMESSAGE_DB_PATH = "/env/chat.db";
    const fs = await import("node:fs");
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockResolvedValue({ close: vi.fn(async () => {}) } as never);
    try {
      const result = await probeFullDiskAccess({
        chatDbPath: "/override/chat.db",
      });
      expect(result.chatDbPath).toBe("/override/chat.db");
    } finally {
      openSpy.mockRestore();
    }
  });
});
