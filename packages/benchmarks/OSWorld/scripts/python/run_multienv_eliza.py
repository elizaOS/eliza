#!/usr/bin/env python3
"""
Run OSWorld benchmark with the Eliza agent.

Uses Eliza's message_service.handle_message() for all decision-making.
Supports both single-task and multi-env parallel execution.

Usage:
    # Single task (Chrome - Enable Do Not Track)
    python scripts/python/run_multienv_eliza.py \
        --provider_name docker \
        --observation_type screenshot_a11y_tree \
        --model qwen/qwen3-32b \
        --max_steps 15 \
        --result_dir ./results/eliza \
        --task_id 030eeff7-b492-4218-b312-701ec99ee0cc

    # All tasks
    python scripts/python/run_multienv_eliza.py \
        --provider_name docker \
        --observation_type screenshot_a11y_tree \
        --model qwen/qwen3-32b \
        --max_steps 15 \
        --num_envs 5 \
        --result_dir ./results/eliza

    # VMware on macOS
    python scripts/python/run_multienv_eliza.py \
        --provider_name vmware \
        --path_to_vm ~/Virtual\\ Machines.localized/Ubuntu.vmwarevm/Ubuntu.vmx \
        --observation_type screenshot_a11y_tree \
        --model qwen/qwen3-32b \
        --max_steps 15 \
        --result_dir ./results/eliza
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import logging
import os
import sys
import time

# Ensure the OSWorld root is on the Python path
OSWORLD_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if OSWORLD_ROOT not in sys.path:
    sys.path.insert(0, OSWORLD_ROOT)

# Ensure protobuf generated modules are importable (Eliza Python package)
_generated_dir = os.path.normpath(os.path.join(
    OSWORLD_ROOT, "..", "..", "eliza", "packages", "python",
    "elizaos", "types", "generated",
))
if os.path.isdir(_generated_dir) and _generated_dir not in sys.path:
    sys.path.insert(0, _generated_dir)

from desktop_env.desktop_env import DesktopEnv
from lib_run_single import run_single_example, setup_logger

logger = logging.getLogger("osworld.eliza.runner")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run OSWorld with Eliza agent")

    # VM / Environment
    parser.add_argument("--provider_name", type=str, default="docker",
                        choices=["vmware", "docker", "virtualbox", "aws"],
                        help="VM provider")
    parser.add_argument("--path_to_vm", type=str, default=None,
                        help="Path to VMware .vmx file (VMware provider only)")
    parser.add_argument("--region", type=str, default=None,
                        help="Cloud region (AWS/Azure)")
    parser.add_argument("--headless", action="store_true",
                        help="Run VMs in headless mode")
    parser.add_argument("--snapshot_name", type=str, default="init_state",
                        help="VM snapshot to revert to")

    # Agent configuration
    parser.add_argument("--model", type=str, default="qwen/qwen3-32b",
                        help="LLM model to use (e.g., qwen/qwen3-32b)")
    parser.add_argument("--observation_type", type=str, default="screenshot_a11y_tree",
                        choices=["screenshot", "a11y_tree", "screenshot_a11y_tree"],
                        help="Observation type")
    parser.add_argument("--action_space", type=str, default="pyautogui",
                        choices=["pyautogui", "computer_13"],
                        help="Action space format")
    parser.add_argument("--max_steps", type=int, default=15,
                        help="Max steps per task")
    parser.add_argument("--temperature", type=float, default=0.5)
    parser.add_argument("--max_tokens", type=int, default=2048)
    parser.add_argument("--max_trajectory_length", type=int, default=5)
    parser.add_argument("--a11y_tree_max_tokens", type=int, default=10000)

    # Execution
    parser.add_argument("--result_dir", type=str, default="./results/eliza",
                        help="Directory to store results")
    parser.add_argument("--task_id", type=str, default=None,
                        help="Run a specific task by ID")
    parser.add_argument("--domain", type=str, default=None,
                        help="Run tasks from a specific domain (chrome, gimp, etc.)")
    parser.add_argument("--max_tasks", type=int, default=None,
                        help="Limit number of tasks to run")
    parser.add_argument("--num_envs", type=int, default=1,
                        help="Number of parallel VMs")
    parser.add_argument("--sleep_after_execution", type=float, default=3.0,
                        help="Sleep after each action execution")

    # API keys
    parser.add_argument("--groq_api_key", type=str, default=None,
                        help="Groq API key (or set GROQ_API_KEY env var)")

    return parser.parse_args()


def load_tasks(args: argparse.Namespace) -> list[dict[str, object]]:
    """Load task definitions from OSWorld evaluation examples."""
    test_all_path = os.path.join(OSWORLD_ROOT, "evaluation_examples", "test_all.json")
    with open(test_all_path) as f:
        test_all = json.load(f)

    tasks: list[dict[str, object]] = []

    if args.task_id:
        # Load a specific task
        for domain, task_ids in test_all.items():
            if args.task_id in task_ids:
                task_path = os.path.join(
                    OSWORLD_ROOT, "evaluation_examples", "examples", domain, f"{args.task_id}.json"
                )
                with open(task_path) as f:
                    task = json.load(f)
                tasks.append(task)
                break
        if not tasks:
            raise ValueError(f"Task {args.task_id} not found in any domain")
        return tasks

    # Load by domain or all
    domains = [args.domain] if args.domain else list(test_all.keys())

    for domain in domains:
        if domain not in test_all:
            logger.warning("Domain '%s' not found in test_all.json", domain)
            continue
        for task_id in test_all[domain]:
            task_path = os.path.join(
                OSWORLD_ROOT, "evaluation_examples", "examples", domain, f"{task_id}.json"
            )
            if not os.path.exists(task_path):
                logger.warning("Task file not found: %s", task_path)
                continue
            with open(task_path) as f:
                task = json.load(f)
            tasks.append(task)

    if args.max_tasks:
        tasks = tasks[: args.max_tasks]

    return tasks


def create_eliza_agent(args: argparse.Namespace) -> object:
    """Create and initialize the Eliza OSWorld agent."""
    from mm_agents.eliza_agent import ElizaOSWorldAgent

    agent = ElizaOSWorldAgent(
        platform="ubuntu",
        model=args.model,
        max_tokens=args.max_tokens,
        top_p=0.9,
        temperature=args.temperature,
        action_space=args.action_space,
        observation_type=args.observation_type,
        max_trajectory_length=args.max_trajectory_length,
        a11y_tree_max_tokens=args.a11y_tree_max_tokens,
        max_steps=args.max_steps,
        client_password="password",
        groq_api_key=args.groq_api_key or os.environ.get("GROQ_API_KEY"),
        screen_width=1920,
        screen_height=1080,
    )

    # Initialize async runtime
    asyncio.run(agent.async_init())

    return agent


def run_benchmark(args: argparse.Namespace) -> dict[str, object]:
    """Run the OSWorld benchmark with the Eliza agent."""
    tasks = load_tasks(args)
    logger.info("Loaded %d tasks", len(tasks))

    # Create agent
    agent = create_eliza_agent(args)

    # Create environment
    env_kwargs = {
        "provider_name": args.provider_name,
        "action_space": args.action_space,
        "headless": args.headless,
        "require_a11y_tree": args.observation_type in ("a11y_tree", "screenshot_a11y_tree"),
        "require_terminal": False,
    }
    if args.path_to_vm:
        env_kwargs["path_to_vm"] = args.path_to_vm
    if args.region:
        env_kwargs["region"] = args.region

    env = DesktopEnv(**env_kwargs)

    # Results
    scores: list[float] = []
    results: list[dict[str, object]] = []
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

    for i, task in enumerate(tasks):
        task_id = task["id"]
        domain = task.get("snapshot", "unknown")
        instruction = task.get("instruction", "")

        logger.info("=" * 60)
        logger.info("Task %d/%d: %s (%s)", i + 1, len(tasks), task_id, domain)
        logger.info("Instruction: %s", instruction)
        logger.info("=" * 60)

        # Create result directory
        example_result_dir = os.path.join(
            args.result_dir,
            args.action_space,
            args.observation_type,
            args.model.replace("/", "_"),
            domain,
            task_id,
        )
        os.makedirs(example_result_dir, exist_ok=True)

        try:
            run_single_example(
                agent=agent,
                env=env,
                example=task,
                max_steps=args.max_steps,
                instruction=instruction,
                args=args,
                example_result_dir=example_result_dir,
                scores=scores,
            )

            result_val = scores[-1] if scores else 0.0
            results.append({
                "task_id": task_id,
                "domain": domain,
                "instruction": instruction,
                "score": result_val,
                "result_dir": example_result_dir,
            })

            logger.info("Task %s: score=%.2f", task_id, result_val)

        except Exception as e:
            logger.error("Task %s failed with error: %s", task_id, e, exc_info=True)
            results.append({
                "task_id": task_id,
                "domain": domain,
                "instruction": instruction,
                "score": 0.0,
                "error": str(e),
            })
            scores.append(0.0)

    # Summary
    total = len(scores)
    passed = sum(1 for s in scores if s > 0)
    avg_score = sum(scores) / total if total > 0 else 0

    summary = {
        "model": args.model,
        "agent": "eliza",
        "observation_type": args.observation_type,
        "action_space": args.action_space,
        "total_tasks": total,
        "passed_tasks": passed,
        "overall_success_rate": avg_score,
        "timestamp": timestamp,
        "results": results,
    }

    # Save summary
    summary_path = os.path.join(args.result_dir, f"osworld-eliza-results-{timestamp}.json")
    os.makedirs(os.path.dirname(summary_path), exist_ok=True)
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    logger.info("=" * 60)
    logger.info("BENCHMARK COMPLETE")
    logger.info("  Total tasks: %d", total)
    logger.info("  Passed: %d", passed)
    logger.info("  Success rate: %.2f%%", avg_score * 100)
    logger.info("  Results: %s", summary_path)
    logger.info("=" * 60)

    return summary


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    args = parse_args()

    # Validate
    if args.provider_name == "vmware" and not args.path_to_vm:
        logger.error("VMware provider requires --path_to_vm")
        sys.exit(1)

    run_benchmark(args)


if __name__ == "__main__":
    main()
