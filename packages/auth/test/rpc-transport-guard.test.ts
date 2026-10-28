/**
 * Pins the private-host rule in the two wallet RPC transport guards: plain
 * `http` is allowed only to a private host.
 *
 * Both guards used to compare the hostname against `"./"`, which no hostname
 * contains, so the Monero guard accepted every `http` URL and the AWS KMS guard
 * rejected every private IPv4 one. These cases fail in both directions.
 */
import { describe, expect, it } from "vitest";
import {
  AWS_KMS_EXTERNAL_CUSTODY_PROVIDER_ID,
  AwsKmsExternalKeyCustodyProvider,
} from "../src/server/wallet/aws-kms-external-custody.js";
import type { ExternalKeySignTransactionRequest } from "../src/server/wallet/external-key-custody.js";
import { MoneroWalletRpcBackend } from "../src/server/wallet/monero.js";

const KMS_KEY_ARN =
  "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000";

/** Reached only when the transport guard lets the request through. */
const KMS_REACHED = "stub KMS client reached";

interface SignOutcome {
  message: string | null;
  kmsCalls: number;
}

/**
 * Signs through the real provider with a stub KMS client, so the result shows
 * whether the transport guard passed the request on. No network and no AWS
 * credentials are involved: the stub throws as soon as it is called.
 */
async function signOverRpc(rpcUrl: string): Promise<SignOutcome> {
  let kmsCalls = 0;
  const provider = new AwsKmsExternalKeyCustodyProvider({
    region: "us-east-1",
    client: {
      send: async () => {
        kmsCalls += 1;
        throw new Error(KMS_REACHED);
      },
    },
  });
  const request: ExternalKeySignTransactionRequest = {
    tenantId: "tenant-transport-guard",
    agentId: "agent-transport-guard",
    chainFamily: "evm",
    handle: {
      providerId: AWS_KMS_EXTERNAL_CUSTODY_PROVIDER_ID,
      keyId: KMS_KEY_ARN,
      region: "us-east-1",
    },
    address: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    chainId: 1,
    value: "1",
    broadcast: false,
    rpcUrl,
  };
  try {
    await provider.signTransaction(request);
    return { message: null, kmsCalls };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      kmsCalls,
    };
  }
}

function moneroBackend(url: string): MoneroWalletRpcBackend {
  return new MoneroWalletRpcBackend({
    network: "mainnet",
    rpcUrl: `${url}/json_rpc`,
    daemonUrl: url,
    rpcLogin: "user:password",
  });
}

describe("Monero wallet RPC transport guard", () => {
  it("rejects plain http to a public host or address", () => {
    for (const url of [
      "http://wallet.example.com",
      "http://203.0.113.9",
      "http://8.8.8.8:18083",
    ]) {
      expect(() => moneroBackend(url), url).toThrow(
        "must use HTTPS for a non-private host",
      );
    }
  });

  it("accepts plain http to a private host, address, or service name", () => {
    for (const url of [
      "http://localhost:18083",
      "http://127.0.0.1:18083",
      "http://10.0.0.1:18083",
      "http://192.168.1.5:18083",
      "http://172.16.0.9:18083",
      "http://monero-wallet-rpc:18083",
    ]) {
      expect(() => moneroBackend(url), url).not.toThrow();
    }
  });

  it("accepts https to a public host", () => {
    expect(() => moneroBackend("https://wallet.example.com")).not.toThrow();
  });
});

describe("AWS KMS external custody EVM RPC transport guard", () => {
  it("rejects plain http to a public host or address before any KMS call", async () => {
    for (const url of ["http://example.com:8545", "http://203.0.113.9:8545"]) {
      const outcome = await signOverRpc(url);
      expect(outcome.message, url).toContain(
        "must use HTTPS for a non-private host",
      );
      expect(outcome.kmsCalls, url).toBe(0);
    }
  });

  it("accepts plain http to a private IPv4 host or address", async () => {
    for (const url of [
      "http://10.0.0.1:8545",
      "http://127.0.0.1:8545",
      "http://192.168.1.5:8545",
      "http://172.16.0.9:8545",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:10.0.0.1]:8545",
    ]) {
      const outcome = await signOverRpc(url);
      expect(outcome.message, url).toBe(KMS_REACHED);
      expect(outcome.kmsCalls, url).toBe(1);
    }
  });

  it("accepts plain http to the loopback names and https to a public host", async () => {
    for (const url of [
      "http://localhost:8545",
      "http://[::1]:8545",
      "http://[fd00::1]:8545",
      "https://example.com/rpc",
    ]) {
      const outcome = await signOverRpc(url);
      expect(outcome.message, url).toBe(KMS_REACHED);
    }
  });
});
