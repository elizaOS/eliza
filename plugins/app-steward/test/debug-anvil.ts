/**
 * Debug script to test Anvil and contract deployment directly
 */

import { ethers } from "ethers";
import { startAnvil } from "./anvil-helper";
import { deployContracts } from "./contract-deployer";

async function main() {
  console.log("Starting Anvil...");
  const anvil = await startAnvil();
  console.log(`Anvil started on ${anvil.rpcUrl}`);
  console.log(`Funded wallet: ${anvil.fundedWallet.address}`);

  try {
    // Check nonce before deployment
    const nonceBefore = await anvil.fundedWallet.getNonce();
    console.log(`Nonce before deployment: ${nonceBefore}`);

    // Check balance
    const balance = await anvil.fundedWallet.provider?.getBalance(
      anvil.fundedWallet.address,
    );
    console.log(`Balance: ${ethers.formatEther(balance ?? 0n)} ETH`);

    console.log("Deploying contracts...");
    const contracts = await deployContracts(anvil.fundedWallet);
    console.log(`Registry deployed at: ${contracts.registry.address}`);
    console.log(`Collection deployed at: ${contracts.collection.address}`);

    // Check nonce after deployment
    const nonceAfter = await anvil.fundedWallet.getNonce();
    console.log(`Nonce after deployment: ${nonceAfter}`);

    console.log("\nAll tests passed!");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    console.log("Stopping Anvil...");
    await anvil.stop();
  }
}

main().catch(console.error);
