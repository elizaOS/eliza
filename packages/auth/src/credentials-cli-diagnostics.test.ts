/**
 * Exercises deferred startup diagnostics against real temporary CLI credential
 * files. The network boundary rejects unexpected refreshes; storage and the
 * diagnostic path remain real so an expired external login cannot be rotated.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySubscriptionCredentialsDeferred } from "./credentials.ts";

let tempHome: string;
let credentialsPath: string;
let network: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-cli-diagnostic-"));
  for (const name of ["HOME", "USERPROFILE", "ELIZA_HOME", "ELIZA_STATE_DIR"]) {
    vi.stubEnv(name, tempHome);
  }
  vi.stubEnv("ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS", "");
  credentialsPath = path.join(tempHome, ".claude", ".credentials.json");
  await fs.mkdir(path.dirname(credentialsPath));
  network = vi.fn(async () => {
    throw new Error("Diagnostics must not exchange external credentials");
  });
  vi.stubGlobal("fetch", network);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(tempHome, { recursive: true, force: true });
});

describe("external CLI startup diagnostics", () => {
  it.each([0, Date.now() + 3_600_000])(
    "leaves external credentials and network untouched at expiry %s",
    async (expiresAt) => {
      const bytes = JSON.stringify({
        claudeAiOauth: {
          accessToken: "fixture-access",
          refreshToken: "fixture-refresh",
          expiresAt,
        },
      });
      await fs.writeFile(credentialsPath, bytes);
      const before = await fs.stat(credentialsPath);
      await Promise.all(
        Array.from({ length: 4 }, () => applySubscriptionCredentialsDeferred()),
      );
      expect(network).not.toHaveBeenCalled();
      expect(await fs.readFile(credentialsPath, "utf8")).toBe(bytes);
      expect((await fs.stat(credentialsPath)).mtimeMs).toBe(before.mtimeMs);
      expect(await fs.readdir(path.dirname(credentialsPath))).toEqual([
        ".credentials.json",
      ]);
    },
  );

  it("honors disabled probing and keeps an absent external login unavailable", async () => {
    const info = vi.spyOn(logger, "info");
    await applySubscriptionCredentialsDeferred();
    expect(info).not.toHaveBeenCalled();
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fixture-access",
          refreshToken: "fixture-refresh",
          expiresAt: 0,
        },
      }),
    );
    vi.stubEnv("ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS", "true");
    await applySubscriptionCredentialsDeferred();
    expect(info).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
