/** Verifies isolated Chromium cookie database copies and failure-safe cleanup. */
import { describe, expect, it, vi } from "vitest";
import { readChromiumCookies } from "./credentials.ts";

const CHROME_COOKIE_PATH = "Google/Chrome/Default/Cookies";

function cookieRow() {
  return {
    encrypted_value: Buffer.from("encrypted"),
    expires_utc: 42,
    name: "privy-session",
  };
}

describe("readChromiumCookies temporary database lifecycle", () => {
  it.each(["copy", "open", "schema", "query", "decrypt", "close"] as const)(
    "removes the private temp directory after a %s failure",
    async (failurePhase) => {
      const close = vi.fn(() => {
        if (failurePhase === "close") throw new Error("close failed");
      });
      const rmSync = vi.fn();
      const tempDir = "/tmp/eliza-cookies-test";
      const result = await readChromiumCookies(
        "app.eliza.ai",
        ["privy-session"],
        {
          appSupportDir: "/app-support",
          chmodSync: vi.fn(),
          copyFileSync: vi.fn(() => {
            if (failurePhase === "copy") throw new Error("copy failed");
          }),
          decryptCookieValue: vi.fn(() => {
            if (failurePhase === "decrypt") throw new Error("decrypt failed");
            return "cookie-value";
          }),
          existsSync: (candidate) =>
            String(candidate).endsWith(CHROME_COOKIE_PATH),
          mkdtempSync: vi.fn(() => tempDir),
          openDb: vi.fn(() => {
            if (failurePhase === "open") throw new Error("open failed");
            return {
              close,
              query: () => {
                if (failurePhase === "schema") throw new Error("schema failed");
                return {
                  all: () => {
                    if (failurePhase === "query")
                      throw new Error("query failed");
                    return [cookieRow()];
                  },
                };
              },
            };
          }),
          platform: "darwin",
          readSafeStoragePassword: vi.fn(async () => "password"),
          rmSync,
          tempRootDir: "/tmp",
        },
      );

      expect(rmSync).toHaveBeenCalledWith(tempDir, {
        force: true,
        recursive: true,
      });
      expect(close).toHaveBeenCalledTimes(
        failurePhase === "schema" ||
          failurePhase === "query" ||
          failurePhase === "decrypt" ||
          failurePhase === "close"
          ? 1
          : 0,
      );
      expect(result).toHaveLength(failurePhase === "close" ? 1 : 0);
    },
  );

  it("uses distinct private directories for concurrent scans", async () => {
    let tempSequence = 0;
    const chmodSync = vi.fn();
    const copiedDestinations: string[] = [];
    const removedDirectories: string[] = [];
    const dependencies = {
      appSupportDir: "/app-support",
      chmodSync,
      copyFileSync: vi.fn((_source: string, destination: string) => {
        copiedDestinations.push(destination);
      }),
      decryptCookieValue: vi.fn(() => "cookie-value"),
      existsSync: (candidate: string) => candidate.endsWith(CHROME_COOKIE_PATH),
      mkdtempSync: vi.fn(() => `/tmp/eliza-cookies-${++tempSequence}`),
      openDb: vi.fn(() => ({
        close: vi.fn(),
        query: () => ({ all: () => [cookieRow()] }),
      })),
      platform: "darwin" as const,
      readSafeStoragePassword: vi.fn(async () => "password"),
      rmSync: vi.fn((directory: string) => {
        removedDirectories.push(directory);
      }),
      tempRootDir: "/tmp",
    };

    const [first, second] = await Promise.all([
      readChromiumCookies("app.eliza.ai", ["privy-session"], dependencies),
      readChromiumCookies("app.eliza.ai", ["privy-session"], dependencies),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(new Set(copiedDestinations).size).toBe(2);
    expect(copiedDestinations).toEqual([
      "/tmp/eliza-cookies-1/Cookies",
      "/tmp/eliza-cookies-2/Cookies",
    ]);
    expect(chmodSync).toHaveBeenNthCalledWith(1, "/tmp/eliza-cookies-1", 0o700);
    expect(chmodSync).toHaveBeenNthCalledWith(2, "/tmp/eliza-cookies-2", 0o700);
    expect(removedDirectories).toEqual([
      "/tmp/eliza-cookies-1",
      "/tmp/eliza-cookies-2",
    ]);
  });
});
