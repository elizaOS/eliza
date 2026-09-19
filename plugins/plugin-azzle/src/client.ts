import { Interface, JsonRpcProvider } from "ethers";
import { parseTaskRef, type AzzleMarket } from "@azzle/agents";
import type { Address, Hex, WalletClient } from "viem";

const registryAbi = [
  "function post(uint256 totalAmount,uint64 deadline) returns (uint256)",
  "function claim(uint256 taskId)",
  "function fund(uint256 taskId,uint256 amount)",
  "function markDelivered(uint256 taskId)",
  "function release(uint256 taskId,uint256 amount)",
  "function complete(uint256 taskId)",
  "function taskState(uint256 taskId) view returns (uint8)",
  "function tasks(uint256 taskId) view returns (address poster,address worker,uint256 totalAmount,uint256 funded,uint256 released,uint64 deadline,uint64 fundingDeadline,uint64 deliveredAt,uint8 state)",
] as const;

const iface = new Interface(registryAbi);

export interface AzzleManifest {
  version: "2.0.0";
  chainId: "8453";
  market: AzzleMarket;
  taskRegistry: Address;
}

export interface AzzleWalletClient extends Pick<WalletClient, "sendTransaction" | "getAddresses" | "chain"> {}

export class AzzleClient {
  private readonly provider: JsonRpcProvider;

  constructor(
    private readonly manifest: AzzleManifest,
    rpcUrl: string,
    private readonly wallet: AzzleWalletClient,
  ) {
    if (manifest.version !== "2.0.0" || manifest.chainId !== "8453") {
      throw new Error("AZZLE requires a V2 Base mainnet manifest.");
    }
    if (wallet.chain?.id !== 8453) {
      throw new Error("AZZLE actions require a Base mainnet (8453) wallet.");
    }
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  async post(totalAmountAzlWei: string, deadline: number): Promise<string> {
    if (!/^[1-9]\d*$/.test(totalAmountAzlWei)) throw new Error("totalAmountAzlWei must be positive AZL wei.");
    if (!Number.isSafeInteger(deadline) || deadline <= Math.floor(Date.now() / 1000)) throw new Error("deadline must be a future Unix timestamp.");
    return this.write("post", [BigInt(totalAmountAzlWei), BigInt(deadline)]);
  }

  async claim(taskId: string): Promise<string> {
    return this.write("claim", [this.localTaskId(taskId)]);
  }

  async fund(taskId: string, amountAzlWei: string): Promise<string> {
    return this.write("fund", [this.localTaskId(taskId), this.amount(amountAzlWei)]);
  }

  async markDelivered(taskId: string): Promise<string> {
    return this.write("markDelivered", [this.localTaskId(taskId)]);
  }

  async release(taskId: string, amountAzlWei: string): Promise<string> {
    return this.write("release", [this.localTaskId(taskId), this.amount(amountAzlWei)]);
  }

  async complete(taskId: string): Promise<string> {
    return this.write("complete", [this.localTaskId(taskId)]);
  }

  async status(taskId: string) {
    const localTaskId = this.localTaskId(taskId);
    const row = await this.provider.call({
      to: this.manifest.taskRegistry,
      data: iface.encodeFunctionData("tasks", [localTaskId]),
    });
    const parsed = iface.decodeFunctionResult("tasks", row);
    return {
      taskId,
      poster: parsed.poster as string,
      worker: parsed.worker as string,
      totalAmountAzlWei: parsed.totalAmount.toString(),
      fundedAzlWei: parsed.funded.toString(),
      releasedAzlWei: parsed.released.toString(),
      state: Number(parsed.state),
    };
  }

  private async write(
    functionName: "post" | "claim" | "fund" | "markDelivered" | "release" | "complete",
    args: readonly bigint[],
  ): Promise<string> {
    const account = (await this.wallet.getAddresses())[0];
    if (!account) throw new Error("AZZLE wallet has no account.");
    return this.wallet.sendTransaction({
      account,
      chain: this.wallet.chain,
      to: this.manifest.taskRegistry,
      data: iface.encodeFunctionData(functionName, args) as Hex,
    });
  }

  private localTaskId(taskId: string): bigint {
    return parseTaskRef(taskId, this.manifest.market).localIdBigInt;
  }

  private amount(value: string): bigint {
    if (!/^[1-9]\d*$/.test(value)) throw new Error("amountAzlWei must be positive AZL wei.");
    return BigInt(value);
  }
}
