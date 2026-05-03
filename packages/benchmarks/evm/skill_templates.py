"""
TypeScript skill templates for the EVM benchmark.

Uses viem for EVM interactions. Each template generates a TypeScript module with:
    export async function executeSkill(rpcUrl: string, privateKey: string, chainId: number): Promise<string>

Bytecodes are Forge-compiled from contracts/ (Solc 0.8.33, optimizer 200 runs).
All templates verified working on Anvil 2026-02-07.
"""

from benchmarks.evm.bytecodes import ERC20_BYTECODE, NFT_BYTECODE, ERC1155_BYTECODE


def _common_imports() -> str:
    return """import {
  createPublicClient, createWalletClient, http, parseEther,
  encodeFunctionData, getContractAddress, type Hex, type Address,
  parseAbi, keccak256, toHex, pad, encodePacked, concat, toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
"""


def _setup_clients() -> str:
    return """
  const account = privateKeyToAccount(privateKey as Hex);
  const chain = { ...anvil, id: chainId };
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const results: Array<{txHash: string; to: string; selector: string; success: boolean; deployedAddress?: string}> = [];
"""


def _send_tx_helper() -> str:
    return """
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
"""


def _skill_wrapper(body: str) -> str:
    return f"""{_common_imports()}

export async function executeSkill(rpcUrl: string, privateKey: string, chainId: number = 31337): Promise<string> {{
{_setup_clients()}
{_send_tx_helper()}
{body}

  return JSON.stringify({{ results, error: null }});
}}
"""


# =========================================================================
# Template 1: Native ETH Transfers (2 rewards)
# =========================================================================

def eth_transfer_template() -> str:
    return _skill_wrapper("""
  await sendAndTrack({ to: '0x000000000000000000000000000000000000dEaD' as Address, value: parseEther('0.001') });
  await sendAndTrack({ to: account.address, value: parseEther('0.0001') });
""")


# =========================================================================
# Template 2: Deploy ERC20 + basic ops (5 rewards: deploy + mint + transfer + approve + balanceOf)
# =========================================================================

def deploy_erc20_template() -> str:
    return _skill_wrapper(f"""
  const ERC20_ABI = parseAbi([
    'function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)',
    'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  ]);
  const {{ deployedAddress: addr }} = await sendAndTrack({{ to: null, data: '{ERC20_BYTECODE}' as Hex }});
  if (!addr) return JSON.stringify({{ results, error: 'ERC20 deploy failed' }});
  const erc20 = addr as Address;
  const dead = '0x000000000000000000000000000000000000dEaD' as Address;
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'mint', args: [account.address, 10n**21n] }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'transfer', args: [dead, 10n**18n] }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'approve', args: [dead, 10n**18n] }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }}) }});
""")


# =========================================================================
# Template 3: ERC20 advanced (8 rewards: name+symbol+decimals+totalSupply+allowance+increaseAllowance+decreaseAllowance+burn)
# These selectors don't overlap with template 2. transferFrom also here.
# =========================================================================

def erc20_advanced_template() -> str:
    return _skill_wrapper(f"""
  const ERC20_ABI = parseAbi([
    'function name() view returns (string)', 'function symbol() view returns (string)',
    'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function mint(address,uint256)', 'function burn(uint256)',
    'function approve(address,uint256) returns (bool)',
    'function transferFrom(address,address,uint256) returns (bool)',
    'function increaseAllowance(address,uint256) returns (bool)',
    'function decreaseAllowance(address,uint256) returns (bool)',
  ]);
  const {{ deployedAddress: addr }} = await sendAndTrack({{ to: null, data: '{ERC20_BYTECODE}' as Hex }});
  if (!addr) return JSON.stringify({{ results, error: 'ERC20 deploy failed' }});
  const erc20 = addr as Address;
  const dead = '0x000000000000000000000000000000000000dEaD' as Address;
  // Mint first so we have tokens
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'mint', args: [account.address, 10n**21n] }}) }});
  // View functions (each unique selector)
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'name' }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'symbol' }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'decimals' }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'totalSupply' }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'allowance', args: [account.address, dead] }}) }});
  // Mutating functions
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'increaseAllowance', args: [dead, 10n**18n] }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'decreaseAllowance', args: [dead, 5n*10n**17n] }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'burn', args: [10n**17n] }}) }});
  // approve + transferFrom
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'approve', args: [account.address, 10n**18n] }}) }});
  await sendAndTrack({{ to: erc20, data: encodeFunctionData({{ abi: ERC20_ABI, functionName: 'transferFrom', args: [account.address, dead, 5n*10n**17n] }}) }});
""")


# =========================================================================
# Template 4: Deploy ERC721 + NFT ops
# =========================================================================

def deploy_nft_template() -> str:
    return _skill_wrapper(f"""
  const NFT_ABI = parseAbi([
    'function safeMint(address,uint256)', 'function approve(address,uint256)',
    'function transferFrom(address,address,uint256)', 'function safeTransferFrom(address,address,uint256)',
    'function setApprovalForAll(address,bool)', 'function ownerOf(uint256) view returns (address)',
    'function supportsInterface(bytes4) view returns (bool)',
  ]);
  const {{ deployedAddress: addr }} = await sendAndTrack({{ to: null, data: '{NFT_BYTECODE}' as Hex }});
  if (!addr) return JSON.stringify({{ results, error: 'NFT deploy failed' }});
  const nft = addr as Address;
  const dead = '0x000000000000000000000000000000000000dEaD' as Address;
  // Mint token #1 and #2
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'safeMint', args: [account.address, 1n] }}) }});
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'safeMint', args: [account.address, 2n] }}) }});
  // approve token #1
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'approve', args: [dead, 1n] }}) }});
  // ownerOf (view function — was missing before, now actually called)
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'ownerOf', args: [1n] }}) }});
  // transferFrom token #1
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'transferFrom', args: [account.address, dead, 1n] }}) }});
  // setApprovalForAll
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'setApprovalForAll', args: [dead, true] }}) }});
  // safeTransferFrom token #2
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'safeTransferFrom', args: [account.address, dead, 2n] }}) }});
  // supportsInterface
  await sendAndTrack({{ to: nft, data: encodeFunctionData({{ abi: NFT_ABI, functionName: 'supportsInterface', args: ['0x80ac58cd'] }}) }});
""")


# =========================================================================
# Template 5: Deploy ERC1155 + multi-token ops
# =========================================================================

def deploy_erc1155_template() -> str:
    return _skill_wrapper(f"""
  const ERC1155_ABI = parseAbi([
    'function mint(address,uint256,uint256,bytes)', 'function safeTransferFrom(address,address,uint256,uint256,bytes)',
    'function setApprovalForAll(address,bool)', 'function balanceOf(uint256,address) view returns (uint256)',
    'function uri(uint256) view returns (string)', 'function supportsInterface(bytes4) view returns (bool)',
    'function isApprovedForAll(address,address) view returns (bool)',
  ]);
  const {{ deployedAddress: addr }} = await sendAndTrack({{ to: null, data: '{ERC1155_BYTECODE}' as Hex }});
  if (!addr) return JSON.stringify({{ results, error: 'ERC1155 deploy failed' }});
  const mt = addr as Address;
  const dead = '0x000000000000000000000000000000000000dEaD' as Address;
  // Mint token id=1, amount=100
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'mint', args: [account.address, 1n, 100n, '0x'] }}) }});
  // safeTransferFrom
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'safeTransferFrom', args: [account.address, dead, 1n, 10n, '0x'] }}) }});
  // setApprovalForAll
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'setApprovalForAll', args: [dead, true] }}) }});
  // balanceOf (view via tx)
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'balanceOf', args: [1n, account.address] }}) }});
  // uri
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'uri', args: [1n] }}) }});
  // supportsInterface
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'supportsInterface', args: ['0xd9b67a26'] }}) }});
  // isApprovedForAll
  await sendAndTrack({{ to: mt, data: encodeFunctionData({{ abi: ERC1155_ABI, functionName: 'isApprovedForAll', args: [account.address, dead] }}) }});
""")


# =========================================================================
# Templates 6-9: Precompiles (verified working)
# =========================================================================

def precompile_batch1_template() -> str:
    """identity (0x04), SHA-256 (0x02), RIPEMD-160 (0x03)."""
    return _skill_wrapper("""
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000004' as Address, data: '0x48656c6c6f20576f726c64' as Hex });
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000002' as Address, data: '0x48656c6c6f20576f726c64' as Hex });
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000003' as Address, data: '0x48656c6c6f20576f726c64' as Hex });
""")


def precompile_batch2_template() -> str:
    """ecRecover (0x01), ecAdd (0x06), ecMul (0x07)."""
    return _skill_wrapper("""
  const msgHash = keccak256(toHex('test message'));
  const ecRecoverData = concat([msgHash, pad(toHex(27), { size: 32 }),
    pad('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hex, { size: 32 }),
    pad('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as Hex, { size: 32 })]);
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000001' as Address, data: ecRecoverData });

  const ecAddData = concat([pad(toHex(1),{size:32}), pad(toHex(2),{size:32}), pad(toHex(1),{size:32}), pad(toHex(2),{size:32})]);
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000006' as Address, data: ecAddData });

  const ecMulData = concat([pad(toHex(1),{size:32}), pad(toHex(2),{size:32}), pad(toHex(2),{size:32})]);
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000007' as Address, data: ecMulData });
""")


def precompile_batch3_template() -> str:
    """modexp (0x05), blake2f (0x09)."""
    return _skill_wrapper("""
  const modExpData = concat([pad(toHex(1),{size:32}), pad(toHex(1),{size:32}), pad(toHex(1),{size:32}), '0x02' as Hex, '0x0a' as Hex, '0xff' as Hex]);
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000005' as Address, data: modExpData });

  const blake2fData = concat(['0x0000000c' as Hex,
    '0x48c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5d182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b' as Hex,
    pad('0x00' as Hex, { size: 128 }), pad(toHex(3), { size: 8 }), pad('0x00' as Hex, { size: 8 }), '0x01' as Hex]);
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000009' as Address, data: blake2fData });
""")


def deploy_weth_template() -> str:
    """Deploy WETH9 + deposit/withdraw/transfer/approve."""
    return _skill_wrapper("""
  const WETH_ABI = parseAbi([
    'function deposit() payable', 'function withdraw(uint256)',
    'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)',
  ]);
  const wethBytecode = '0x60606040526040805190810160405280600d81526020017f577261707065642045746865720000000000000000000000000000000000000000815250600090805190602001906200005292919062000128565b506040805190810160405280600481526020017f5745544800000000000000000000000000000000000000000000000000000000815250600190805190602001906200009f92919062000128565b5060126002553415620000ae57fe5b5b620001d7565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10620000f857805160ff191683800117855562000129565b8280016001018555821562000129579182015b82811115620001285782518255916020019190600101906200010b565b5b5090506200013891906200013c565b5090565b6200016191905b808211156200015d576000816000905550600101620001435b5090565b90565b6106b280620001e76000396000f3006060604052361561008c576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff168063095ea7b31461009157806318160ddd146100e857806323b872dd1461010e578063313ce5671461018457806370a08231146101b0578063a9059cbb146101fa578063d0e30db014610251578063dd62ed3e1461025b575b61008f5b61008f336102c4565b5b565b005b341561009957fe5b6100ce600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610357565b604051808215151515815260200191505060405180910390f35b34156100f057fe5b6100f8610449565b6040518082815260200191505060405180910390f35b341561011657fe5b61016a600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610453565b604051808215151515815260200191505060405180910390f35b341561018c57fe5b61019461063e565b604051808260ff1660ff16815260200191505060405180910390f35b34156101b857fe5b6101e4600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610651565b6040518082815260200191505060405180910390f35b341561020257fe5b610237600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610669565b604051808215151515815260200191505060405180910390f35b610259610680565b005b341561026357fe5b6102ae600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610690565b6040518082815260200191505060405180910390f35b5b5b50565b005b005b005b6040518082815260200191505060405180910390f35b005b6040518082815260200191505060405180910390f35b005b005b6040518082815260200191505060405180910390f3' as Hex;
  const { deployedAddress: wethAddr } = await sendAndTrack({ to: null, data: wethBytecode });
  if (!wethAddr) return JSON.stringify({ results, error: 'WETH deploy failed' });
  const weth = wethAddr as Address;
  const dead = '0x000000000000000000000000000000000000dEaD' as Address;
  await sendAndTrack({ to: weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), value: parseEther('1.0') });
  await sendAndTrack({ to: weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [parseEther('0.5')] }) });
  await sendAndTrack({ to: weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'transfer', args: [dead, parseEther('0.1')] }) });
  await sendAndTrack({ to: weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'approve', args: [dead, parseEther('10')] }) });
""")


def precompile_ecpairing_template() -> str:
    return _skill_wrapper("""
  await sendAndTrack({ to: '0x0000000000000000000000000000000000000008' as Address, data: '0x' as Hex });
""")


# =========================================================================
# Template registry — reward values will be verified by live run
# =========================================================================

# Expected reward values — will be verified by live run after changes.
DETERMINISTIC_TEMPLATES: list[tuple[str, int, str]] = [
    ("eth_transfer",          2, "Native ETH transfers"),
    ("deploy_erc20",          5, "Deploy ERC20 + mint, transfer, approve, balanceOf"),
    ("erc20_advanced",       11, "ERC20: name, symbol, decimals, totalSupply, allowance, increaseAllowance, decreaseAllowance, burn, transferFrom"),
    ("deploy_nft",            7, "Deploy ERC721 + safeMint, approve, ownerOf, transferFrom, safeTransferFrom, setApprovalForAll, supportsInterface"),
    ("deploy_erc1155",        8, "Deploy ERC1155 + mint, safeTransferFrom, setApprovalForAll, balanceOf, uri, supportsInterface, isApprovedForAll"),
    ("precompile_batch1",     3, "Precompiles: identity, SHA-256, RIPEMD-160"),
    ("precompile_batch2",     3, "Precompiles: ecRecover, ecAdd, ecMul"),
    ("precompile_batch3",     2, "Precompiles: modexp, blake2f"),
    ("deploy_weth",           5, "Deploy WETH9 + deposit, withdraw, transfer, approve"),
    ("precompile_ecpairing",  1, "Precompile: ecPairing"),
]

_TEMPLATE_DISPATCH: dict[str, object] = {
    "eth_transfer":         lambda: eth_transfer_template(),
    "deploy_erc20":         lambda: deploy_erc20_template(),
    "erc20_advanced":       lambda: erc20_advanced_template(),
    "deploy_nft":           lambda: deploy_nft_template(),
    "deploy_erc1155":       lambda: deploy_erc1155_template(),
    "precompile_batch1":    lambda: precompile_batch1_template(),
    "precompile_batch2":    lambda: precompile_batch2_template(),
    "precompile_batch3":    lambda: precompile_batch3_template(),
    "deploy_weth":          lambda: deploy_weth_template(),
    "precompile_ecpairing": lambda: precompile_ecpairing_template(),
}


def get_template_for_step(step: int) -> tuple[str, str]:
    if step < 0 or step >= len(DETERMINISTIC_TEMPLATES):
        return ("", "")
    name = DETERMINISTIC_TEMPLATES[step][0]
    fn = _TEMPLATE_DISPATCH.get(name)
    if fn is None:
        return ("", "")
    return (name, fn())


def get_total_expected_deterministic_reward() -> int:
    return sum(entry[1] for entry in DETERMINISTIC_TEMPLATES)
