"""Script to run evaluation on the benchmark.
Utils and basic architecture credit to https://github.com/web-arena-x/webarena/blob/main/run.py.
"""

import argparse
import datetime
import json
import logging
import os
import sys
from typing import List, Dict
import math
from tqdm import tqdm
from multiprocessing import Process, Manager

# Add project root to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import lib_run_single
from desktop_env.desktop_env import DesktopEnv
from mm_agents.mobileagent_v3.mobile_agent import MobileAgentV3

#  Logger Configs {{{ #
logger = logging.getLogger()
logger.setLevel(logging.DEBUG)

datetime_str: str = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")

file_handler = logging.FileHandler(
    os.path.join("logs", "normal-{:}.log".format(datetime_str)), encoding="utf-8"
)
debug_handler = logging.FileHandler(
    os.path.join("logs", "debug-{:}.log".format(datetime_str)), encoding="utf-8"
)
stdout_handler = logging.StreamHandler(sys.stdout)
sdebug_handler = logging.FileHandler(
    os.path.join("logs", "sdebug-{:}.log".format(datetime_str)), encoding="utf-8"
)

file_handler.setLevel(logging.INFO)
debug_handler.setLevel(logging.DEBUG)
stdout_handler.setLevel(logging.INFO)
sdebug_handler.setLevel(logging.DEBUG)

formatter = logging.Formatter(
    fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
)
file_handler.setFormatter(formatter)
debug_handler.setFormatter(formatter)
stdout_handler.setFormatter(formatter)
sdebug_handler.setFormatter(formatter)

stdout_handler.addFilter(logging.Filter("desktopenv"))
sdebug_handler.addFilter(logging.Filter("desktopenv"))

logger.addHandler(file_handler)
logger.addHandler(debug_handler)
logger.addHandler(stdout_handler)
logger.addHandler(sdebug_handler)
#  }}} Logger Configs #

logger = logging.getLogger("desktopenv.experiment")


def config() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run end-to-end evaluation on the benchmark"
    )

    # environment config
    parser.add_argument("--path_to_vm", type=str, default=None)
    parser.add_argument(
        "--headless", action="store_true", help="Run in headless machine"
    )
    parser.add_argument(
        "--action_space", type=str, default="pyautogui", help="Action type"
    )
    parser.add_argument(
        "--observation_type",
        choices=["screenshot", "a11y_tree", "screenshot_a11y_tree", "som"],
        default="screenshot",
        help="Observation type",
    )
    parser.add_argument("--screen_width", type=int, default=1920)
    parser.add_argument("--screen_height", type=int, default=1080)
    parser.add_argument("--sleep_after_execution", type=float, default=10.0)
    parser.add_argument("--max_steps", type=int, default=50)

    # agent config
    parser.add_argument("--max_trajectory_length", type=int, default=50)
    parser.add_argument(
        "--test_config_base_dir", type=str, default="evaluation_examples"
    )

    # lm config
    parser.add_argument("--model", type=str, default="")
    parser.add_argument("--engine", type=str, default="openai")
    parser.add_argument("--api_key", type=str, default="")
    parser.add_argument("--api_url", type=str, default="")

    parser.add_argument("--manager_model", type=str, default="")
    parser.add_argument("--worker_model", type=str, default="")
    parser.add_argument("--reflector_model", type=str, default="")
    parser.add_argument("--grounding_model", type=str, default="")
    parser.add_argument("--grounding_stage", type=int, default=1)
    parser.add_argument("--grounding_info_level", type=int, default=1)

    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--top_p", type=float, default=0.9)
    parser.add_argument("--max_tokens", type=int, default=1500)

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument(
        "--test_all_meta_path", type=str, default="evaluation_examples/test_all.json"
    )

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results")
    parser.add_argument("--num_envs", type=int, default=1, help="Number of environments to run in parallel")

    parser.add_argument("--enable_rag", type=int, default=1)
    parser.add_argument("--rag_path", type=str, default="mm_agents/mobileagent_v3/Perplexica_rag_knowledge_verified.json")
    parser.add_argument("--guide_path", type=str, default="mm_agents/mobileagent_v3/experience.json")

    args = parser.parse_args()
    return args


def distribute_tasks(test_all_meta: dict, num_envs: int) -> List[Dict]:
    """Distribute tasks evenly across environments."""
    # Flatten the tasks into a single list
    all_tasks = []
    for domain, examples in test_all_meta.items():
        for example_id in examples:
            all_tasks.append((domain, example_id))
    
    # Calculate tasks per environment
    tasks_per_env = math.ceil(len(all_tasks) / num_envs)
    
    # Distribute tasks
    distributed_tasks = []
    for i in range(num_envs):
        env_tasks = {}
        start_idx = i * tasks_per_env
        end_idx = min((i + 1) * tasks_per_env, len(all_tasks))
        
        for domain, example_id in all_tasks[start_idx:end_idx]:
            if domain not in env_tasks:
                env_tasks[domain] = []
            env_tasks[domain].append(example_id)
        
        distributed_tasks.append(env_tasks)
    
    return distributed_tasks


def run_env_tasks(env_idx: int, env: DesktopEnv, agent, env_tasks: dict, args: argparse.Namespace, shared_scores: list):
    """Run tasks for a single environment."""
    logger.info(f"Executing tasks in environment {env_idx + 1}/{args.num_envs}")
    
    for domain in tqdm(env_tasks, desc=f"Env{env_idx+1}-Domain"):
        for example_id in tqdm(env_tasks[domain], desc="Example", leave=False):
            config_file = os.path.join(
                args.test_config_base_dir, f"examples/{domain}/{example_id}.json"
            )
            with open(config_file, "r", encoding="utf-8") as f:
                example = json.load(f)

            logger.info(f"[Env {env_idx+1}][Domain]: {domain}")
            logger.info(f"[Env {env_idx+1}][Example ID]: {example_id}")
            logger.info(f"[Env {env_idx+1}][Instruction]: {example['instruction']}")
            
            example_result_dir = os.path.join(
                args.result_dir,
                args.action_space,
                args.observation_type,
                args.model,
                domain,
                example_id,
            )
            os.makedirs(example_result_dir, exist_ok=True)

            try:
                lib_run_single.run_single_example_mobileagent_v3(
                    agent,
                    env,
                    example,
                    args.max_steps,
                    example["instruction"],
                    args,
                    example_result_dir,
                    shared_scores,
                )
            except Exception as e:
                logger.error(f"Exception in Env{env_idx+1} {domain}/{example_id}: {e}")
                env.controller.end_recording(
                    os.path.join(example_result_dir, "recording.mp4")
                )
                with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                    f.write(
                        json.dumps(
                            {"Error": f"Time limit exceeded in {domain}/{example_id}"}
                        )
                    )
                    f.write("\n")
    
    env.close()


def test(args: argparse.Namespace, test_all_meta: dict) -> None:
    logger.info("Args: %s", args)
    
    distributed_tasks = distribute_tasks(test_all_meta, args.num_envs)
    
    # First, set up all environments
    logger.info("Setting up all environments...")
    envs = []
    agents = []
    
    for env_idx in range(args.num_envs):
        logger.info(f"Setting up environment {env_idx + 1}/{args.num_envs}")

        manager_engine_params = {"engine_type": args.engine, "api_key": args.api_key, "base_url": args.api_url, "model": args.model if args.model!="" else args.manager_model}
        worker_engine_params = {"engine_type": args.engine, "api_key": args.api_key, "base_url": args.api_url, "model": args.model if args.model!="" else args.worker_model}
        reflector_engine_params = {"engine_type": args.engine, "api_key": args.api_key, "base_url": args.api_url, "model": args.model if args.model!="" else args.reflector_model}
        grounding_engine_params = {"engine_type": args.engine, "api_key": args.api_key, "base_url": args.api_url, "model": args.model if args.model!="" else args.grounding_model}

        agent = MobileAgentV3(
            manager_engine_params,
            worker_engine_params,
            reflector_engine_params,
            grounding_engine_params,
        )
        agents.append(agent)

        env = DesktopEnv(
            provider_name='aws',
            region="us-east-1",
            path_to_vm=args.path_to_vm,
            action_space=args.action_space,
            screen_size=(args.screen_width, args.screen_height),
            headless=args.headless,
            os_type="Ubuntu",
            require_a11y_tree=args.observation_type
            in ["a11y_tree", "screenshot_a11y_tree", "som"],
        )
        envs.append(env)
    
    logger.info("All environments are ready. Starting parallel task execution...")
    
    # Create a shared list for scores across processes
    with Manager() as manager:
        shared_scores = manager.list()
        
        # Create and start processes for each environment
        processes = []
        for env_idx, (env, agent, env_tasks) in enumerate(zip(envs, agents, distributed_tasks)):
            p = Process(
                target=run_env_tasks,
                args=(env_idx, env, agent, env_tasks, args, shared_scores)
            )
            processes.append(p)
            p.start()
        
        # Wait for all processes to complete
        for p in processes:
            p.join()
        
        # Convert shared list to regular list
        scores = list(shared_scores)
    
    logger.info(f"Average score: {sum(scores) / len(scores) if scores else 0}")


def get_unfinished(
    action_space, use_model, observation_type, result_dir, total_file_json
):
    target_dir = os.path.join(result_dir, action_space, observation_type, use_model)

    if not os.path.exists(target_dir):
        return total_file_json

    finished = {}
    for domain in os.listdir(target_dir):
        finished[domain] = []
        domain_path = os.path.join(target_dir, domain)
        if os.path.isdir(domain_path):
            for example_id in os.listdir(domain_path):
                if example_id == "onboard":
                    continue
                example_path = os.path.join(domain_path, example_id)
                if os.path.isdir(example_path):
                    if "result.txt" not in os.listdir(example_path):
                        # empty all files under example_id
                        for file in os.listdir(example_path):
                            os.remove(os.path.join(example_path, file))
                    else:
                        finished[domain].append(example_id)

    if not finished:
        return total_file_json

    for domain, examples in finished.items():
        if domain in total_file_json:
            total_file_json[domain] = [
                x for x in total_file_json[domain] if x not in examples
            ]

    return total_file_json


def get_result(action_space, use_model, observation_type, result_dir, total_file_json):
    target_dir = os.path.join(result_dir, action_space, observation_type, use_model)
    if not os.path.exists(target_dir):
        print("New experiment, no result yet.")
        return None

    all_result = []

    for domain in os.listdir(target_dir):
        domain_path = os.path.join(target_dir, domain)
        if os.path.isdir(domain_path):
            for example_id in os.listdir(domain_path):
                example_path = os.path.join(domain_path, example_id)
                if os.path.isdir(example_path):
                    if "result.txt" in os.listdir(example_path):
                        # empty all files under example_id
                        try:
                            all_result.append(
                                float(
                                    open(
                                        os.path.join(example_path, "result.txt"), "r"
                                    ).read()
                                )
                            )
                        except:
                            all_result.append(0.0)

    if not all_result:
        print("New experiment, no result yet.")
        return None
    else:
        print("Current Success Rate:", sum(all_result) / len(all_result) * 100, "%")
        return all_result


if __name__ == "__main__":
    ####### The complete version of the list of examples #######
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    args = config()

    with open(args.test_all_meta_path, "r", encoding="utf-8") as f:
        test_all_meta = json.load(f)

    if args.domain != "all":
        test_all_meta = {args.domain: test_all_meta[args.domain]}

    test_file_list = get_unfinished(
        args.action_space,
        args.manager_model+"_"+args.worker_model if args.model=='dual' else args.model,
        args.observation_type,
        args.result_dir,
        test_all_meta,
    )
    left_info = ""
    for domain in test_file_list:
        left_info += f"{domain}: {len(test_file_list[domain])}\n"
    logger.info(f"Left tasks:\n{left_info}")

    get_result(
        args.action_space,
        args.model,
        args.observation_type,
        args.result_dir,
        test_all_meta,
    )
    test(args, test_file_list)
