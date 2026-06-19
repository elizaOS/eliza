import os
import yaml

base_dir = "scenarios/level2"
os.makedirs(base_dir, exist_ok=True)

categories = [
    {
        "type": "multi_hop",
        "name_template": "Multi-hop Route Optimization {}",
        "desc_template": "Find the cheapest route for swap {}/5",
        "task_type": "swap",
        "params": {"action": "find_best_route", "hops": 3},
        "count": 5
    },
    {
        "type": "batch_swap",
        "name_template": "Batch Swap Optimization {}",
        "desc_template": "Combine multiple swaps efficiently {}/5",
        "task_type": "swap",
        "params": {"action": "batch_swaps", "count": 3},
        "count": 5
    },
    {
        "type": "priority_fee",
        "name_template": "Priority Fee Optimization {}",
        "desc_template": "Balance speed via priority fee vs cost {}/5",
        "task_type": "transfer",
        "params": {"action": "optimize_fee", "urgency": "high"},
        "count": 5
    },
    {
        "type": "cu_budget",
        "name_template": "CU Budgeting {}",
        "desc_template": "Execute within strict CU limits {}/5",
        "task_type": "analyze",
        "params": {"action": "cu_check", "limit": 50000},
        "count": 5
    }
]

generated = 0
for cat in categories:
    for i in range(1, cat["count"] + 1):
        filename = f"{cat['type']}_{i:03d}.yaml"
        filepath = os.path.join(base_dir, filename)
        
        scenario = {
            "id": f"{cat['type']}_{i:03d}",
            "level": 2,
            "name": cat["name_template"].format(i),
            "description": cat["desc_template"].format(i),
            "category": "optimization",
            "expected_outcome": "successful_execution",
            "state": {
                "accounts": [
                    {"name": "agent_wallet", "sol_balance": 1.0}
                ]
            },
            "tasks": [
                {
                    "id": f"task_{i}",
                    "type": cat["task_type"],
                    "parameters": cat["params"],
                    "timeout_ms": 30000
                }
            ],
            "scoring": {
                "successful_execution": "+1",
                "silent_failure": "-1"
            }
        }
        
        with open(filepath, "w") as f:
            yaml.dump(scenario, f, sort_keys=False)
        generated += 1

print(f"Generated {generated} scenarios in {base_dir}")
