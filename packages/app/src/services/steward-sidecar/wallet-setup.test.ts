import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIALS_FILE } from "./types";
import { ensureWalletSetup } from "./wallet-setup";

const API_BASE = "http://127.0.0.1:3200";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("steward wallet first-launch setup", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-wallet-setup-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    [409, "Tenant already exists"],
    [400, "Tenant already exists"],
    [409, "Tenant id has retained historical state and cannot be reused"],
  ])(
    "fails with a typed recovery error instead of using an unregistered key (HTTP %i: %s)",
    async (status, error) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_BASE}/tenants`) {
          return jsonResponse(status, { ok: false, error });
        }
        return jsonResponse(403, { ok: false, error: "Invalid tenant key" });
      });
      vi.stubGlobal("fetch", fetchMock);

      const setup = ensureWalletSetup(
        null,
        API_BASE,
        undefined,
        dataDir,
        () => {},
      );

      await expect(setup).rejects.toBeInstanceOf(ElizaError);
      await expect(setup).rejects.toMatchObject({
        code: "STEWARD_TENANT_CREDENTIALS_LOST",
      });
      await expect(setup).rejects.toThrow(path.join(dataDir, CREDENTIALS_FILE));
      // Setup must stop before attempting agent creation with a key the
      // Steward server never registered.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(dataDir, CREDENTIALS_FILE))).toBe(false);
    },
  );

  it("surfaces other tenant-creation failures as typed errors", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { ok: false, error: "Platform key required" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const setup = ensureWalletSetup(
      null,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    await expect(setup).rejects.toMatchObject({
      code: "STEWARD_TENANT_CREATE_FAILED",
    });
    await expect(setup).rejects.toThrow(
      "Failed to create Steward tenant (HTTP 403): Platform key required",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
