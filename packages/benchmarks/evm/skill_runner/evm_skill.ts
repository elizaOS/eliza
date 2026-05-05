import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export async function executeSkill(rpcUrl: string, privateKey: *** chainId: number) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({
    chain: { id: chainId, name: 'local', rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    chain: { id: chainId, name: 'local', rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
    account,
  });

  // List of undiscovered selectors per contract
  const targets: { address: `0x${string}`; selectors: string[] }[] = [
    {
      address: '0xcd8a1c3ba11cf5ecfa6267617243239504a98d90',
      selectors: [
        '0x06fdde03', // name()
        '0x95d89b41', // symbol()
        '0x313ce567', // decimals()
        '0x18160ddd', // totalSupply()
        '0xdd62ed3e', // allowance(address,address)
        '0x23b872dd', // transferFrom(address,address,uint256)
        '0x42966c68', // burn(uint256)
        '0x39509351', // increaseAllowance(address,uint256)
        '0xa457c2d7', // decreaseAllowance(address,uint256)
      ],
    },
    {
      address: '0xa4899d35897033b927acfcf422bc745916139776',
      selectors: [
        '0x18160ddd', // totalSupply()
        '0x70a08231', // balanceOf(address)
        '0x23b872dd', // transferFrom(address,address,uint256)
        '0xdd62ed3e', // allowance(address,address)
        '0x06fdde03', // name()
        '0x95d89b41', // symbol()
        '0x313ce567', // decimals()
      ],
    },
    {
      address: '0x21df544947ba3e8b3c32561399e88b52dc8b2823',
      selectors: [
        '0x06fdde03', // name()
        '0x95d89b41', // symbol()
        '0x70a08231', // balanceOf(address)
        '0xc87b56dd', // tokenURI(uint256)
        '0x081812fc', // getApproved(uint256)
        '0xe985e9c5', // isApprovedForAll(address,address)
      ],
    },
    {
      address: '0xf4b146fba71f41e0592668ffbf264f1d186b2ca8',
      selectors: [
        '0x00fdd58e', // balanceOf(address,uint256)
        '0x4e1273f4', // balanceOfBatch(address[],uint256[])
        '0x2eb2c2d6', // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
      ],
    },
    {
      address: '0xc351628eb244ec633d5f21fbd6621e1a683b1181',
      selectors: [
        // Same as ERC20 but treat as separate target
        '0x06fdde03',
        '0x95d89b41',
        '0x313ce567',
        '0x18160ddd',
        '0xdd62ed3e',
        '0x23b872dd',
        '0x42966c68',
        '0x39509351',
        '0xa457c2d7',
      ],
    },
  ];

  const results: { contract: string; selector: string; output?: string; error?: string }[] = [];

  for (const { address, selectors } of targets) {
    for (const selector of selectors) {
      try {
        // Build call data; for selectors requiring parameters we provide zeroed args
        let data = selector;
        // Simple view functions without params: name, symbol, decimals, totalSupply, etc.
        // For functions expecting args, we encode dummy zeros (address(0), uint256(0), etc.)
        if (selector === '0xdd62ed3e' || selector === '0x70a08231' || selector === '0x00fdd58e') {
          // allowance(address,address) or balanceOf(address) or balanceOf(address,uint256)
          const abi = parseAbi(['function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address owner) view returns (uint256)', 'function balanceOf(address account, uint256 id) view returns (uint256)']);
          const args = selector === '0xdd62ed3e' ? ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000'] :
                       selector === '0x00fdd58e' ? ['0x0000000000000000000000000000000000000000', 0] :
                       ['0x0000000000000000000000000000000000000000'];
          data = encodeFunctionData({ abi, functionName: selector === '0xdd62ed3e' ? 'allowance' : selector === '0x00fdd58e' ? 'balanceOf' : 'balanceOf', args });
        } else if (selector === '0x23b872dd' || selector === '0x42966c68' || selector === '0x39509351' || selector === '0xa457c2d7' || selector === '0x2eb2c2d6') {
          // Functions that require parameters; we encode zeros to avoid revert on missing data
          const abi = parseAbi(['function transferFrom(address from, address to, uint256 amount) returns (bool)', 'function burn(uint256 amount)', 'function increaseAllowance(address spender, uint256 addedValue) returns (bool)', 'function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)', 'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)']);
          const args = selector === '0x23b872dd' ? ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0] :
                       selector === '0x42966c68' ? [0] :
                       selector === '0x39509351' ? ['0x0000000000000000000000000000000000000000', 0] :
                       selector === '0xa457c2d7' ? ['0x0000000000000000000000000000000000000000', 0] :
                       [ '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', [], [], '0x' ];
          const fnName = selector === '0x23b872dd' ? 'transferFrom' :
                         selector === '0x42966c68' ? 'burn' :
                         selector === '0x39509351' ? 'increaseAllowance' :
                         selector === '0xa457c2d7' ? 'decreaseAllowance' :
                         'safeBatchTransferFrom';
          data = encodeFunctionData({ abi, functionName: fnName, args });
        }

        const callResult = await publicClient.call({
          to: address as `0x${string}`,
          data: data as `0x${string}`,
        });

        // Decode if possible (optional)
        let output: string | undefined;
        try {
          // Attempt generic decode as bytes
          output = callResult;
        } catch (_) {
          // ignore decode errors
        }

        results.push({ contract: address, selector, output });
      } catch (err: any) {
        results.push({ contract: address, selector, error: err?.message ?? String(err) });
      }
    }
  }

  return JSON.stringify({ results, error: null });
}