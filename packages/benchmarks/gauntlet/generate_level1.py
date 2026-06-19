#!/usr/bin/env python3
"""
Generate Level 1 protocol interaction scenarios.
5 categories × 5-10 variations = 30 scenarios.
"""

import os
import yaml

base_dir = "scenarios/level1"
os.makedirs(base_dir, exist_ok=True)

categories = [
    # Category 1: Token Swaps (10 scenarios)
    {
        "type": "swap",
        "scenarios": [
            {"id": "swap_sol_usdc", "name": "SOL to USDC Swap", "from": "SOL", "to": "USDC", "amount": 0.1},
            {"id": "swap_sol_bonk", "name": "SOL to BONK Swap", "from": "SOL", "to": "BONK", "amount": 0.1},
            {"id": "swap_usdc_usdt", "name": "USDC to USDT Swap", "from": "USDC", "to": "USDT", "amount": 10},
            {"id": "swap_sol_jup", "name": "SOL to JUP Swap", "from": "SOL", "to": "JUP", "amount": 0.1},
            {"id": "swap_sol_ray", "name": "SOL to RAY Swap", "from": "SOL", "to": "RAY", "amount": 0.1},
            {"id": "swap_usdc_sol", "name": "USDC to SOL Swap", "from": "USDC", "to": "SOL", "amount": 10},
            {"id": "swap_bonk_sol", "name": "BONK to SOL Swap", "from": "BONK", "to": "SOL", "amount": 1000000},
            {"id": "swap_jup_usdc", "name": "JUP to USDC Swap", "from": "JUP", "to": "USDC", "amount": 10},
            {"id": "swap_sol_pyth", "name": "SOL to PYTH Swap", "from": "SOL", "to": "PYTH", "amount": 0.1},
            {"id": "swap_sol_jto", "name": "SOL to JTO Swap", "from": "SOL", "to": "JTO", "amount": 0.1},
        ]
    },
    # Category 2: Staking (5 scenarios)
    {
        "type": "stake",
        "scenarios": [
            {"id": "stake_native_001", "name": "Native SOL Stake", "protocol": "native", "amount": 1.0},
            {"id": "stake_marinade_001", "name": "Marinade Stake", "protocol": "marinade", "amount": 1.0},
            {"id": "stake_jito_001", "name": "Jito Stake", "protocol": "jito", "amount": 1.0},
            {"id": "stake_blaze_001", "name": "BlazeStake", "protocol": "blazestake", "amount": 1.0},
            {"id": "stake_cogent_001", "name": "Cogent Stake", "protocol": "cogent", "amount": 1.0},
        ]
    },
    # Category 3: Token Transfers (5 scenarios)
    {
        "type": "transfer",
        "scenarios": [
            {"id": "transfer_sol_001", "name": "SOL Transfer", "token": "SOL", "amount": 0.1},
            {"id": "transfer_usdc_001", "name": "USDC Transfer", "token": "USDC", "amount": 10},
            {"id": "transfer_bonk_001", "name": "BONK Transfer", "token": "BONK", "amount": 100000},
            {"id": "transfer_jup_001", "name": "JUP Transfer", "token": "JUP", "amount": 5},
            {"id": "transfer_ray_001", "name": "RAY Transfer", "token": "RAY", "amount": 2},
        ]
    },
    # Category 4: NFT Operations (5 scenarios)
    {
        "type": "nft",
        "scenarios": [
            {"id": "nft_mint_001", "name": "NFT Mint", "action": "mint", "collection": "test_collection"},
            {"id": "nft_transfer_001", "name": "NFT Transfer", "action": "transfer", "collection": "test_collection"},
            {"id": "nft_burn_001", "name": "NFT Burn", "action": "burn", "collection": "test_collection"},
            {"id": "nft_list_001", "name": "NFT List for Sale", "action": "list", "marketplace": "magic_eden"},
            {"id": "nft_delist_001", "name": "NFT Delist", "action": "delist", "marketplace": "magic_eden"},
        ]
    },
    # Category 5: DeFi Actions (5 scenarios)
    {
        "type": "defi",
        "scenarios": [
            {"id": "defi_deposit_001", "name": "Lending Deposit", "action": "deposit", "protocol": "solend", "amount": 10},
            {"id": "defi_withdraw_001", "name": "Lending Withdraw", "action": "withdraw", "protocol": "solend", "amount": 10},
            {"id": "defi_borrow_001", "name": "Borrow USDC", "action": "borrow", "protocol": "solend", "amount": 5},
            {"id": "defi_repay_001", "name": "Repay Loan", "action": "repay", "protocol": "solend", "amount": 5},
            {"id": "defi_claim_001", "name": "Claim Rewards", "action": "claim", "protocol": "marinade"},
        ]
    },
]

generated = 0
for cat in categories:
    for scenario in cat["scenarios"]:
        filename = f"{scenario['id']}.yaml"
        filepath = os.path.join(base_dir, filename)
        
        # Build task type based on category
        task_type = cat["type"]
        if task_type == "nft":
            task_type = "analyze"  # Use analyze for NFT ops
        elif task_type == "defi":
            task_type = "trade"  # Use trade for DeFi
        
        # Build state based on scenario
        state = {
            "accounts": [
                {"name": "agent_wallet", "sol_balance": 10.0, "tokens": {"USDC": 1000, "BONK": 10000000}}
            ]
        }
        
        # Add pools for swap scenarios
        if cat["type"] == "swap":
            state["pools"] = [
                {
                    "type": "orca_whirlpool",
                    "token_a": scenario["from"],
                    "token_b": scenario["to"],
                    "liquidity": 1000000,
                    "price": 100.0 if scenario["to"] == "USDC" else 1.0
                }
            ]
        
        data = {
            "id": scenario["id"],
            "level": 1,
            "name": scenario["name"],
            "description": f"Level 1 protocol interaction: {scenario['name']}",
            "category": cat["type"],
            "expected_outcome": "successful_execution",
            "state": state,
            "tasks": [
                {
                    "id": f"task_{scenario['id']}",
                    "type": task_type,
                    "parameters": {k: v for k, v in scenario.items() if k not in ["id", "name"]},
                    "timeout_ms": 30000
                }
            ],
            "scoring": {
                "successful_execution": "+1",
                "silent_failure": "-1"
            }
        }
        
        with open(filepath, "w") as f:
            yaml.dump(data, f, sort_keys=False, default_flow_style=False)
        generated += 1
        print(f"  ✓ {scenario['id']}: {scenario['name']}")

print(f"\nGenerated {generated} Level 1 scenarios in {base_dir}")
