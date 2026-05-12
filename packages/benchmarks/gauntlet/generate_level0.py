#!/usr/bin/env python3
"""
Generate Level 0 foundational scenarios.
4 categories × 5 variations = 20 scenarios.
"""

import os
import yaml

base_dir = "scenarios/level0"
os.makedirs(base_dir, exist_ok=True)

categories = [
    # Category 1: PDA Derivation (5 scenarios)
    {
        "type": "pda",
        "scenarios": [
            {"id": "pda_token_001", "name": "Token Program PDA", "program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "seeds": ["mint"]},
            {"id": "pda_metadata_001", "name": "Metaplex Metadata PDA", "program": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "seeds": ["metadata", "mint"]},
            {"id": "pda_stake_001", "name": "Stake Account PDA", "program": "Stake11111111111111111111111111111111111111", "seeds": ["stake", "authority"]},
            {"id": "pda_governance_001", "name": "Governance PDA", "program": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", "seeds": ["realm", "voter"]},
            {"id": "pda_custom_001", "name": "Custom Program PDA", "program": "CustomProgram11111111111111111111111111111", "seeds": ["user", "nonce"]},
        ]
    },
    # Category 2: IDL Parsing (5 scenarios)
    {
        "type": "idl",
        "scenarios": [
            {"id": "idl_jupiter_001", "name": "Jupiter IDL Parse", "program": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "action": "parse_idl"},
            {"id": "idl_orca_001", "name": "Orca Whirlpool IDL", "program": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "action": "parse_idl"},
            {"id": "idl_raydium_001", "name": "Raydium AMM IDL", "program": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "action": "parse_idl"},
            {"id": "idl_drift_001", "name": "Drift Protocol IDL", "program": "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "action": "parse_idl"},
            {"id": "idl_marinade_001", "name": "Marinade Finance IDL", "program": "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", "action": "parse_idl"},
        ]
    },
    # Category 3: Account Queries (5 scenarios)
    {
        "type": "query",
        "scenarios": [
            {"id": "query_balance_001", "name": "SOL Balance Query", "action": "get_balance", "account_type": "wallet"},
            {"id": "query_tokens_001", "name": "Token Accounts Query", "action": "get_token_accounts", "account_type": "token"},
            {"id": "query_nft_001", "name": "NFT Holdings Query", "action": "get_nft_holdings", "account_type": "nft"},
            {"id": "query_stake_001", "name": "Stake Status Query", "action": "get_stake_status", "account_type": "stake"},
            {"id": "query_rent_001", "name": "Rent Exemption Query", "action": "get_rent_exemption", "account_type": "system"},
        ]
    },
    # Category 4: Program Metadata (5 scenarios)
    {
        "type": "metadata",
        "scenarios": [
            {"id": "meta_version_001", "name": "Program Version Check", "action": "check_version", "target": "program"},
            {"id": "meta_authority_001", "name": "Upgrade Authority Check", "action": "check_authority", "target": "upgrade"},
            {"id": "meta_size_001", "name": "Data Size Check", "action": "check_data_size", "target": "account"},
            {"id": "meta_owner_001", "name": "Account Owner Check", "action": "check_owner", "target": "account"},
            {"id": "meta_executable_001", "name": "Executable Check", "action": "check_executable", "target": "program"},
        ]
    },
]

generated = 0
for cat in categories:
    for scenario in cat["scenarios"]:
        filename = f"{scenario['id']}.yaml"
        filepath = os.path.join(base_dir, filename)
        
        data = {
            "id": scenario["id"],
            "level": 0,
            "name": scenario["name"],
            "description": f"Level 0 foundational test: {scenario['name']}",
            "category": cat["type"],
            "expected_outcome": "successful_execution",
            "state": {
                "accounts": [
                    {"name": "agent_wallet", "sol_balance": 1.0}
                ]
            },
            "tasks": [
                {
                    "id": f"task_{scenario['id']}",
                    "type": "query",
                    "parameters": {k: v for k, v in scenario.items() if k not in ["id", "name"]},
                    "timeout_ms": 10000
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

print(f"\nGenerated {generated} Level 0 scenarios in {base_dir}")
