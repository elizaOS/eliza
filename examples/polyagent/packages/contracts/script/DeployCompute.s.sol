// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/compute/ComputeRegistry.sol";
import "../src/compute/LedgerManager.sol";
import "../src/compute/InferenceServing.sol";
import "../src/compute/ComputeStaking.sol";
import "../src/moderation/BanManager.sol";

/**
 * @title DeployCompute
 * @notice Deploys the Polyagent Compute Marketplace contracts
 * @dev Run with: forge script script/DeployCompute.s.sol --rpc-url $RPC_URL --broadcast
 */
contract DeployCompute is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying Polyagent Compute Marketplace");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy BanManager first (used by ComputeStaking)
        BanManager banManager = new BanManager(deployer, deployer);
        console.log("BanManager deployed at:", address(banManager));

        // Deploy ComputeRegistry
        ComputeRegistry registry = new ComputeRegistry(deployer);
        console.log("ComputeRegistry deployed at:", address(registry));

        // Deploy LedgerManager
        LedgerManager ledger = new LedgerManager(address(registry), deployer);
        console.log("LedgerManager deployed at:", address(ledger));

        // Deploy InferenceServing
        InferenceServing inference = new InferenceServing(
            address(registry),
            address(ledger),
            deployer
        );
        console.log("InferenceServing deployed at:", address(inference));

        // Authorize InferenceServing to call LedgerManager.processSettlement
        ledger.setInferenceContract(address(inference));
        console.log("InferenceServing authorized on LedgerManager");

        // Deploy ComputeStaking
        ComputeStaking staking = new ComputeStaking(address(banManager), deployer);
        console.log("ComputeStaking deployed at:", address(staking));

        vm.stopBroadcast();

        // Output deployment summary
        console.log("\n========== DEPLOYMENT SUMMARY ==========");
        console.log("Network:", block.chainid);
        console.log("BanManager:", address(banManager));
        console.log("ComputeRegistry:", address(registry));
        console.log("LedgerManager:", address(ledger));
        console.log("InferenceServing:", address(inference));
        console.log("ComputeStaking:", address(staking));
        console.log("=========================================\n");
    }
}

