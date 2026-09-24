"""Script to run end-to-end evaluation on the benchmark.
Utils and basic architecture credit to https://github.com/web-arena-x/webarena/blob/main/run.py.
"""

import argparse
import datetime
import json
import logging
import os
import sys
import math
import ast
import time
import backoff
import httpx
import requests
from tqdm import tqdm
from typing import Optional, Dict, Any
from multiprocessing import Pool
from openai import APIConnectionError, APIError, RateLimitError
from types import SimpleNamespace


# Add project root to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import lib_run_single
from run_autoglm_v import DesktopEnv, get_unfinished, get_result
from desktop_env.desktop_env import MAX_RETRIES, DesktopEnv as DesktopEnvBase
from mm_agents.autoglm_v import AutoGLMAgent
from openai import OpenAI

logger = logging.getLogger("desktopenv.experiment")

def config() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run end-to-end evaluation on the benchmark")

    # environment config
    parser.add_argument("--path_to_vm", type=str)
    parser.add_argument(
        "--provider_name",
        type=str,
        default="docker",
        help="Virtualization provider (vmware, docker, aws, azure, gcp, virtualbox)",
    )
    parser.add_argument("--headless", action="store_true", default=True, help="Run in headless machine")
    parser.add_argument("--action_space", type=str, default="autoglm_computer_use", help="Action type")
    parser.add_argument(
        "--observation_type",
        choices=["screenshot", "a11y_tree", "screenshot_a11y_tree", "som"],
        default="a11y_tree",
        help="Observation type",
    )
    parser.add_argument("--screen_width", type=int, default=1920)
    parser.add_argument("--screen_height", type=int, default=1080)
    parser.add_argument("--sleep_after_execution", type=float, default=1.0)
    parser.add_argument("--max_steps", type=int, default=30)

    # agent config
    parser.add_argument("--max_trajectory_length", type=int, default=3)
    parser.add_argument("--test_config_base_dir", type=str, default="evaluation_examples/examples")

    # lm config
    parser.add_argument("--model", type=str, default="autoglm-os")
    parser.add_argument("--temperature", type=float, default=0.4)
    parser.add_argument("--top_p", type=float, default=0.5)
    parser.add_argument("--max_tokens", type=int, default=2048)
    parser.add_argument("--stop_token", type=str, default=None)
    parser.add_argument("--image_width", type=int, default=1280)
    parser.add_argument("--image_height", type=int, default=720)

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument("--test_all_meta_path", type=str, default="evaluation_examples/test_nogdrive.json")

    # aws config
    parser.add_argument(
        "--region", type=str, default="us-east-1", help="AWS region for the VM"
    )
    parser.add_argument("--client_password", type=str, default="", help="Client password")

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results")
    
    # parallel number
    parser.add_argument("--num_workers", type=int, default=20, help="Number of parallel workers")
    args = parser.parse_args()

    return args

def _worker_run(task):
    domain, example_id, args = task  # args 为 argparse.Namespace
    logger = logging.getLogger("desktopenv.experiment")
    try:
        config_file = os.path.join(args.test_config_base_dir, f"{domain}/{example_id}.json")
        with open(config_file, "r", encoding="utf-8") as f:
            example = json.load(f)
        instruction = example["instruction"]

        @backoff.on_exception(backoff.constant, (RateLimitError, APIConnectionError), interval=0.1)
        def call_llm(messages):
            logger.info("Calling LLM...")
            
            # Prepare the request data
            data = {
                "model": args.model,
                "messages": messages,
                "max_tokens": args.max_tokens,
                "temperature": args.temperature,
                "top_p": args.top_p,
                "skip_special_tokens": False,
                "stream": False,
                "include_stop_str_in_output": True,
                "stop": ["<|user|>", "<|observation|>", "</answer>"]
            }
            
            # Set up proxy
            # if os.environ.get('LAN_PROXY', None):
            #     proxies = {
            #         "http": os.environ.get('LAN_PROXY'),
            #         "https": os.environ.get('LAN_PROXY')
            #     }
            # else:
            #     proxies = None

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', '')}"
            }
            
            # Get API base URL from environment or use default
            base_url = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1')
            url = f"{base_url}/chat/completions"
            
            response = requests.post(
                url,
                json=data,
                headers=headers,
                # proxies=proxies,
                timeout=60.0
            )
            response.raise_for_status()
            
            result = response.json()
            logger.info("LLM called successfully.")
            return result['choices'][0]['message']['content']

        env = DesktopEnv(
            provider_name=args.provider_name,
            region=args.region,
            client_password=args.client_password,
            path_to_vm=args.path_to_vm,
            action_space=args.action_space,
            screen_size=(args.screen_width, args.screen_height),
            headless=args.headless,
            os_type="Ubuntu",
            require_a11y_tree=args.observation_type in ["a11y_tree", "screenshot_a11y_tree", "som"],
        )
        agent = AutoGLMAgent(
            action_space=args.action_space,
            observation_type=args.observation_type,
            screen_size=(args.screen_width, args.screen_height),
            image_size=(args.image_width, args.image_height),
            max_trajectory_length=args.max_trajectory_length,
            client_password=args.client_password,
            gen_func=call_llm,
        )

        example_result_dir = os.path.join(
            args.result_dir,
            args.action_space,
            args.observation_type,
            args.model,
            domain,
            example_id,
        )
        os.makedirs(example_result_dir, exist_ok=True)

        local_scores = []
        try:
            lib_run_single.run_single_example_autoglm(
                agent,
                env,
                example,
                args.max_steps,
                instruction,
                args,
                example_result_dir,
                local_scores,
            )
        except Exception as e:
            logger.error(f"[并发任务异常] {domain}/{example_id}: {e}")
            if hasattr(env, "controller") and env.controller is not None:
                try:
                    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))
                except Exception:
                    pass
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({"Error": f"Exception in {domain}/{example_id}: {str(e)}"}) + "\n")
        finally:
            try:
                env.close()
            except Exception:
                pass

        score = None
        result_path = os.path.join(example_result_dir, "result.txt")
        if os.path.exists(result_path):
            try:
                with open(result_path, "r") as rf:
                    res = rf.read().strip()
                    if res.lower() == "true":
                        score = 1.0
                    else:
                        score = float(res)
            except Exception:
                score = 0.0
        else:
            score = 0.0
        logger.info(f"[Finish] {domain}/{example_id} score={score}")
        return (domain, example_id, score)
    except Exception as e:
        logger = logging.getLogger("desktopenv.experiment")
        logger.error(f"[Initializing Fail] {domain}/{example_id}: {e}")
        return (domain, example_id, 0.0)

def test_parallel(args: argparse.Namespace, test_all_meta: dict):
    tasks = []
    for domain in test_all_meta:
        for example_id in test_all_meta[domain]:
            tasks.append((domain, example_id, args))
    if not tasks:
        logger.info("No pending tasks")
        return
    logger.info(f"Starting parallel execution: {args.num_workers} processes, {len(tasks)} tasks total")

    results = []
    with Pool(processes=args.num_workers) as pool:
        for res in tqdm(pool.imap_unordered(_worker_run, tasks), total=len(tasks), desc="Parallel execution"):
            results.append(res)

    scores = [s for (_, _, s) in results if s is not None]
    if scores:
        avg = sum(scores) / len(scores)
        logger.info(f"Parallel execution completed. Average score: {avg}")
    else:
        logger.info("No scores obtained.")

if __name__ == "__main__":
    ####### The complete version of the list of examples #######
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    args = config()
    if args.client_password == "":
        if args.provider_name == "aws":
            args.client_password = "osworld-public-evaluation"
        else:
            args.client_password = "password"
    else:
        args.client_password = args.client_password

    # save args to json in result_dir/action_space/observation_type/model/args.json
    path_to_args = os.path.join(
        args.result_dir,
        args.action_space,
        args.observation_type,
        args.model,
        "args.json",
    )
    os.makedirs(os.path.dirname(path_to_args), exist_ok=True)
    with open(path_to_args, "w", encoding="utf-8") as f:
        json.dump(vars(args), f, indent=4)

    with open(args.test_all_meta_path, "r", encoding="utf-8") as f:
        test_all_meta = json.load(f)

    if args.domain != "all":
        test_all_meta = {args.domain: test_all_meta[args.domain]}

    test_file_list = get_unfinished(
        args.action_space,
        args.model,
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
    test_parallel(args, test_file_list)
