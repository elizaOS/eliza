// Exercises identity client behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, mock, test } from "bun:test";
import { type Hash } from "viem";
import { ERC8004_IDENTITY_REGISTRY_ADDRESSES, ERC8004IdentityClient } from "./identity-client";

const registry = ERC8004_IDENTITY_REGISTRY_ADDRESSES[97];
const txHash = `0x${"1".repeat(64)}` as Hash;

function mockClient() {
  const state = { uri: "ipfs://old", owner: "0x000000000000000000000000000000000000dEaD" };
  const registered = {
    data: "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c697066733a2f2f6167656e740000000000000000000000000000000000",
    topics: [
      "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a",
      "0x00000000000000000000000000000000000000000000000000000000000004d2",
      "0x000000000000000000000000000000000000000000000000000000000000dead",
    ],
  };
  const publicClient = {
    waitForTransactionReceipt: mock(async () => ({
      logs: [{ address: registry, data: registered.data, topics: registered.topics }],
    })),
    readContract: mock(async ({ functionName }: { functionName: string }) => {
      if (functionName === "ownerOf") return state.owner;
      if (functionName === "tokenURI") return state.uri;
      throw new Error(`unexpected read ${functionName}`);
    }),
  };
  const walletClient = {
    account: state.owner,
    chain: undefined,
    writeContract: mock(
      async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        if (functionName === "setAgentURI") state.uri = args[1] as string;
        return txHash;
      },
    ),
  };
  return { state, publicClient, walletClient };
}

describe("ERC8004IdentityClient", () => {
  test("register returns agentId parsed from Registered event", async () => {
    const { publicClient, walletClient } = mockClient();
    const client = new ERC8004IdentityClient({
      chainId: 97,
      registryAddress: registry,
      rpcUrl: "http://127.0.0.1:8545",
      publicClient: publicClient as never,
    });

    await expect(
      client.register({ agentURI: "ipfs://agent", signer: walletClient as never }),
    ).resolves.toEqual({
      agentId: 1234n,
      txHash,
    });
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "register", args: ["ipfs://agent"] }),
    );
  });

  test("reads ownerOf", async () => {
    const { publicClient, walletClient } = mockClient();
    const client = new ERC8004IdentityClient({
      chainId: 97,
      registryAddress: registry,
      rpcUrl: "http://127.0.0.1:8545",
      publicClient: publicClient as never,
    });

    await expect(client.getOwner(1234n)).resolves.toBe(walletClient.account);
  });

  test("URI read/write round-trip", async () => {
    const { publicClient, walletClient } = mockClient();
    const client = new ERC8004IdentityClient({
      chainId: 97,
      registryAddress: registry,
      rpcUrl: "http://127.0.0.1:8545",
      publicClient: publicClient as never,
    });

    await expect(client.getAgentURI(1234n)).resolves.toBe("ipfs://old");
    await expect(
      client.setAgentURI({ agentId: 1234n, uri: "ipfs://new", signer: walletClient as never }),
    ).resolves.toBe(txHash);
    await expect(client.getAgentURI(1234n)).resolves.toBe("ipfs://new");
  });
});
