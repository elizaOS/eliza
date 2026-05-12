import {
  createPublicClient, createWalletClient, http, parseEther,
  encodeFunctionData, getContractAddress, type Hex, type Address,
  parseAbi, keccak256, toHex, pad, encodePacked, concat, toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';


export async function executeSkill(rpcUrl: string, privateKey: string, chainId: number = 31337): Promise<string> {

  const account = privateKeyToAccount(privateKey as Hex);
  const chain = { ...anvil, id: chainId };
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const results: Array<{txHash: string; to: string; selector: string; success: boolean; deployedAddress?: string}> = [];


  async function sendAndTrack(params: {to?: Address | null; data?: Hex; value?: bigint}) {
    try {
      const txHash = await walletClient.sendTransaction({
        to: params.to ?? undefined, data: params.data, value: params.value ?? 0n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const selector = params.data && params.data.length >= 10 ? params.data.slice(0, 10) : '0x';
      const toAddr = params.to ?? '0x0000000000000000000000000000000000000000';
      results.push({
        txHash, to: toAddr, selector, success: receipt.status === 'success',
        deployedAddress: receipt.contractAddress ?? undefined,
      });
      return { receipt, txHash, deployedAddress: receipt.contractAddress };
    } catch (e: unknown) {
      results.push({
        txHash: '', to: params.to ?? '0x0000000000000000000000000000000000000000',
        selector: params.data?.slice(0, 10) ?? '0x', success: false,
      });
      return { receipt: null, txHash: '', deployedAddress: undefined };
    }
  }


  await sendAndTrack({ to: '0x0000000000000000000000000000000000000008' as Address, data: '0x' as Hex });


  return JSON.stringify({ results, error: null });
}
