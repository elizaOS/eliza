import { afterEach, expect, test } from "bun:test";
import {
  clearConfiguredVaults,
  getConfiguredVault,
} from "../api/services/vault-factory";

const originalRpc = process.env.RPC_URL;
afterEach(() => {
  if (originalRpc === undefined) delete process.env.RPC_URL;
  else process.env.RPC_URL = originalRpc;
  clearConfiguredVaults();
});

test("configuration changes and shutdown release the cached vault", () => {
  const options = { fallbackPassword: "test-only-vault-password" };
  process.env.RPC_URL = "https://first.example.test";
  const first = getConfiguredVault(options);
  expect(getConfiguredVault(options)).toBe(first);
  process.env.RPC_URL = "https://second.example.test";
  expect(getConfiguredVault(options)).not.toBe(first);
  const second = getConfiguredVault(options);
  clearConfiguredVaults();
  expect(getConfiguredVault(options)).not.toBe(second);
});

test("auth shutdown releases the prior credential encryption root", async () => {
  const {
    encryptImportSessionJson,
    decryptImportSessionJson,
    releaseAuthStores,
  } = await import("../api/services/auth-lifecycle");
  const previous = process.env.STEWARD_MASTER_PASSWORD;
  try {
    releaseAuthStores();
    process.env.STEWARD_MASTER_PASSWORD = "first-runtime-credential-root";
    const first = encryptImportSessionJson({ credential: "fixture" });
    expect(decryptImportSessionJson<{ credential: string }>(first)).toEqual({
      credential: "fixture",
    });
    releaseAuthStores();
    process.env.STEWARD_MASTER_PASSWORD = "second-runtime-credential-root";
    expect(() =>
      decryptImportSessionJson<{ credential: string }>(first),
    ).toThrow();
    const second = encryptImportSessionJson({ credential: "second" });
    expect(decryptImportSessionJson<{ credential: string }>(second)).toEqual({
      credential: "second",
    });
    releaseAuthStores();
    process.env.STEWARD_MASTER_PASSWORD = "first-runtime-credential-root";
    expect(decryptImportSessionJson<{ credential: string }>(first)).toEqual({
      credential: "fixture",
    });
  } finally {
    releaseAuthStores();
    if (previous === undefined) delete process.env.STEWARD_MASTER_PASSWORD;
    else process.env.STEWARD_MASTER_PASSWORD = previous;
  }
});
