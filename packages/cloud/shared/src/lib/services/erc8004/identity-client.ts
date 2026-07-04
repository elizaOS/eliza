// Coordinates cloud service identity client behavior behind route handlers.
import {
  type Address,
  createPublicClient,
  decodeEventLog,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";
import IdentityRegistryAbi from "./abis/IdentityRegistry.json";

export const identityRegistryAbi = IdentityRegistryAbi;

export type ERC8004ChainId = 56 | 97;

export const ERC8004_IDENTITY_REGISTRY_ADDRESSES: Record<ERC8004ChainId, Address> = {
  56: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  97: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

export class ERC8004IdentityClient {
  readonly chainId: ERC8004ChainId;
  readonly registryAddress: Address;
  readonly publicClient: PublicClient;

  constructor(opts: {
    chainId: ERC8004ChainId;
    registryAddress: Address;
    rpcUrl: string;
    publicClient?: PublicClient;
  }) {
    this.chainId = opts.chainId;
    this.registryAddress = opts.registryAddress;
    this.publicClient =
      opts.publicClient ??
      createPublicClient({
        chain: opts.chainId === 56 ? bsc : bscTestnet,
        transport: http(opts.rpcUrl),
      });
  }

  async register(opts: {
    agentURI: string;
    signer: WalletClient;
  }): Promise<{ agentId: bigint; txHash: Hash }> {
    const txHash = await opts.signer.writeContract({
      address: this.registryAddress,
      abi: IdentityRegistryAbi,
      functionName: "register",
      args: [opts.agentURI],
      chain: opts.signer.chain ?? (this.chainId === 56 ? bsc : bscTestnet),
      account: opts.signer.account!,
    });
    const agentId = await this.getAgentId(txHash);
    return { agentId, txHash };
  }

  async getAgentId(txHash: Hash): Promise<bigint> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.registryAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: IdentityRegistryAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "Registered") {
          const args = decoded.args as { agentId?: bigint } | readonly unknown[];
          if (Array.isArray(args)) {
            return args[0] as bigint;
          }
          const namedArgs = args as { agentId?: bigint };
          if (typeof namedArgs.agentId === "bigint") return namedArgs.agentId;
        }
      } catch {
        // Not an IdentityRegistry event; skip it.
      }
    }
    throw new Error(`Registered event not found for transaction ${txHash}`);
  }

  async getOwner(agentId: bigint): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: IdentityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    })) as Address;
  }

  async getAgentURI(agentId: bigint): Promise<string> {
    return (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: IdentityRegistryAbi,
      functionName: "tokenURI",
      args: [agentId],
    })) as string;
  }

  async setAgentURI(opts: { agentId: bigint; uri: string; signer: WalletClient }): Promise<Hash> {
    return opts.signer.writeContract({
      address: this.registryAddress,
      abi: IdentityRegistryAbi,
      functionName: "setAgentURI",
      args: [opts.agentId, opts.uri],
      chain: opts.signer.chain ?? (this.chainId === 56 ? bsc : bscTestnet),
      account: opts.signer.account!,
    });
  }

  async setMetadata(opts: {
    agentId: bigint;
    key: string;
    value: Hex;
    signer: WalletClient;
  }): Promise<Hash> {
    return opts.signer.writeContract({
      address: this.registryAddress,
      abi: IdentityRegistryAbi,
      functionName: "setMetadata",
      args: [opts.agentId, opts.key, opts.value],
      chain: opts.signer.chain ?? (this.chainId === 56 ? bsc : bscTestnet),
      account: opts.signer.account!,
    });
  }
}
