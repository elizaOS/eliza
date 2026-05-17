/**
 * Anvil test helper — spawns and manages a local Anvil node for e2e tests.
 *
 * Provides:
 * - Automatic port selection
 * - Wallet funding from test accounts
 * - Clean startup/shutdown
 */

import { type ChildProcess, spawn } from "node:child_process";
import { ethers } from "ethers";

export interface AnvilInstance {
  process: ChildProcess;
  rpcUrl: string;
  port: number;
  provider: ethers.JsonRpcProvider;
  /** First Anvil test account (funded with 10000 ETH) */
  fundedWallet: ethers.Wallet;
  /** All 10 Anvil test accounts */
  accounts: Array<{ address: string; privateKey: string }>;
  /** Stop the Anvil instance */
  stop: () => Promise<void>;
  /** Fund an address with ETH from the funded wallet */
  fund: (address: string, amountEth: string) => Promise<string>;
}

// Anvil's default test accounts (same as Hardhat)
const ANVIL_ACCOUNTS = [
  {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey:
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
  {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey:
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  },
  {
    address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    privateKey:
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  },
  {
    address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    privateKey:
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  },
  {
    address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    privateKey:
      "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  },
  {
    address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    privateKey:
      "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  },
  {
    address: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    privateKey:
      "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  },
  {
    address: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
    privateKey:
      "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  },
];

/**
 * Find an available port for Anvil.
 * Tries ports starting from 8545, returns the first available.
 */
async function findAvailablePort(startPort = 8545): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, _reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      // Port in use, try next
      resolve(findAvailablePort(startPort + 1));
    });
    server.listen(startPort, "127.0.0.1", () => {
      server.close(() => resolve(startPort));
    });
  });
}

/**
 * Wait for Anvil to be ready by polling the RPC endpoint.
 */
async function waitForAnvil(
  rpcUrl: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_chainId",
          params: [],
          id: 1,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { result?: string };
        if (data.result) return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Spawn a new Anvil instance for testing.
 *
 * @param options.chainId - Chain ID to use (default: 31337)
 * @param options.blockTime - Block time in seconds (default: 0 = instant mining)
 * @returns AnvilInstance with RPC URL, provider, and control methods
 */
export async function startAnvil(options?: {
  chainId?: number;
  blockTime?: number;
}): Promise<AnvilInstance> {
  const port = await findAvailablePort();
  const chainId = options?.chainId ?? 31337;
  const blockTime = options?.blockTime ?? 0;

  const args = [
    "--port",
    String(port),
    "--chain-id",
    String(chainId),
    "--accounts",
    "10",
    "--balance",
    "10000",
  ];

  if (blockTime > 0) {
    args.push("--block-time", String(blockTime));
  }

  const anvilProcess = spawn("anvil", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const rpcUrl = `http://127.0.0.1:${port}`;

  // Wait for Anvil to be ready
  const ready = await Promise.race([
    waitForAnvil(rpcUrl),
    new Promise<boolean>((_resolve, reject) => {
      anvilProcess.once("error", (error) => reject(error));
    }),
  ]).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start Anvil process: ${message}`);
  });
  if (!ready) {
    anvilProcess.kill();
    throw new Error(`Anvil failed to start on port ${port}`);
  }

  // Additional stabilization delay and verification
  await new Promise((r) => setTimeout(r, 500));

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Verify the provider is fully connected and responsive
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) {
    anvilProcess.kill();
    throw new Error(
      `Anvil chain ID mismatch: expected ${chainId}, got ${network.chainId}`,
    );
  }

  // Verify the first account has expected balance
  const balance = await provider.getBalance(ANVIL_ACCOUNTS[0].address);
  if (balance === 0n) {
    anvilProcess.kill();
    throw new Error("Anvil account #0 has no balance");
  }

  // Use account #9 for deployment, account #0 for funding
  // This avoids nonce tracking issues between deploy and fund operations
  const deployerAccount = ANVIL_ACCOUNTS[9];
  const funderAccount = ANVIL_ACCOUNTS[0];

  const fundedWallet = new ethers.Wallet(deployerAccount.privateKey, provider);
  const funderWallet = new ethers.Wallet(funderAccount.privateKey, provider);

  // Verify the deployer nonce is 0 (fresh chain)
  const nonce = await fundedWallet.getNonce();
  if (nonce !== 0) {
    anvilProcess.kill();
    throw new Error(
      `Anvil deployer account nonce is ${nonce}, expected 0 for fresh chain`,
    );
  }

  const stop = async (): Promise<void> => {
    return new Promise((resolve) => {
      if (anvilProcess.killed) {
        resolve();
        return;
      }
      anvilProcess.on("exit", () => resolve());
      anvilProcess.kill("SIGTERM");
      // Force kill after 5s if still running
      setTimeout(() => {
        if (!anvilProcess.killed) {
          anvilProcess.kill("SIGKILL");
        }
        resolve();
      }, 5000);
    });
  };

  const fund = async (address: string, amountEth: string): Promise<string> => {
    // Use funder wallet (different from deployer) to avoid nonce conflicts
    // Create a fresh provider for nonce lookup to avoid ethers.js v6 caching issues
    const freshProvider = new ethers.JsonRpcProvider(rpcUrl);
    const nonce = await freshProvider.getTransactionCount(
      funderAccount.address,
      "pending",
    );
    freshProvider.destroy();

    const tx = await funderWallet.sendTransaction({
      to: address,
      value: ethers.parseEther(amountEth),
      nonce,
    });
    await tx.wait();
    return tx.hash;
  };

  return {
    process: anvilProcess,
    rpcUrl,
    port,
    provider,
    fundedWallet,
    accounts: ANVIL_ACCOUNTS,
    stop,
    fund,
  };
}

/**
 * Deploy a contract using ethers.js ContractFactory.
 */
export async function deployContract(
  wallet: ethers.Wallet,
  abi: ethers.InterfaceAbi,
  bytecode: string,
  ...constructorArgs: unknown[]
): Promise<ethers.Contract> {
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...constructorArgs);
  await contract.waitForDeployment();
  return contract as ethers.Contract;
}
