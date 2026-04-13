"""Run OSWorld evaluation using hosted GBOX service"""
from __future__ import annotations
import argparse
import datetime
import json
import logging
import os
import sys
import signal
import time
from typing import List
from multiprocessing import Process, Manager
from multiprocessing import current_process

# Add project root to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import lib_run_single
from desktop_env.desktop_env import DesktopEnv
from mm_agents.hosted_gbox_agent import HostedGboxAgent

# Global variables for signal handling
active_environments = []
processes = []
is_terminating = False

# load the environment variables from .env file
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

#  Logger Configs {{{ #
def config() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run OSWorld evaluation with hosted GBOX service"
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
    parser.add_argument("--sleep_after_execution", type=float, default=0.0)
    parser.add_argument("--max_steps", type=int, default=15)

    # agent config
    parser.add_argument("--max_trajectory_length", type=int, default=3)
    parser.add_argument(
        "--test_config_base_dir", type=str, default="evaluation_examples"
    )

    # Hosted GBOX service config
    parser.add_argument(
        "--gbox_service_url",
        type=str,
        default=os.getenv("GBOX_SERVICE_URL", "http://44.201.221.203:8000"),
        help="URL of hosted GBOX service"
    )
    parser.add_argument(
        "--gbox_service_api_key",
        type=str,
        default=os.getenv("GBOX_SERVICE_API_KEY"),
        help="API key for hosted GBOX service"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        help="Claude model to use (default: Bedrock Sonnet 4.5)"
    )
    parser.add_argument("--max_tokens", type=int, default=1500)

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument(
        "--test_all_meta_path", type=str, default="evaluation_examples/test_all.json"
    )

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results_hosted_gbox")
    parser.add_argument("--num_envs", type=int, default=1, help="Number of environments to run in parallel")
    parser.add_argument("--log_level", type=str, choices=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'],
                       default='INFO', help="Set the logging level")

    # aws config
    parser.add_argument(
        "--region", type=str, default="us-east-1", help="AWS region for the VM"
    )
    parser.add_argument(
        "--provider_name", type=str, default="aws", help="Cloud provider name"
    )
    parser.add_argument(
        "--screen_width", type=int, default=1920, help="Screen width"
    )
    parser.add_argument(
        "--screen_height", type=int, default=1080, help="Screen height"
    )
    parser.add_argument(
        "--client_password",
        type=str,
        default=os.getenv("CLIENT_PASSWORD", "osworld-public-evaluation"),
        help="Client password (default: osworld-public-evaluation)"
    )

    args = parser.parse_args()
    return args


# }}} Logger Configs #

def setup_logger(env_idx: int = None, result_dir: str = "./results_gbox", level: str = 'INFO') -> logging.Logger:
    """Set up a logger for the current process.

    Args:
        env_idx: Environment index for naming (None for main process)
        result_dir: Directory to store logs
        level: Logging level

    Returns:
        Configured logger instance
    """
    # Set log level
    numeric_level = getattr(logging, level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f'Invalid log level: {level}')

    # Create logger
    if env_idx is not None:
        logger_name = f"osworld-worker-{env_idx}"
    else:
        logger_name = "osworld-main"

    logger = logging.getLogger(logger_name)
    logger.setLevel(numeric_level)

    # Remove existing handlers
    logger.handlers.clear()

    # Create formatters and handlers
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(numeric_level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # File handler
    os.makedirs(result_dir, exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    if env_idx is not None:
        log_file = os.path.join(result_dir, f"worker_{env_idx}_{timestamp}.log")
    else:
        log_file = os.path.join(result_dir, f"main_{timestamp}.log")

    file_handler = logging.FileHandler(log_file)
    file_handler.setLevel(numeric_level)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger


logger = logging.getLogger("osworld-main")


def check_completed_tasks(result_dir: str, test_all_meta: dict) -> List[str]:
    """Check which tasks have already been completed.

    Args:
        result_dir: Directory containing results
        test_all_meta: Dictionary of domain -> list of task IDs

    Returns:
        List of completed task IDs (format: "domain/task_id")
    """
    completed = []
    for domain, examples in test_all_meta.items():
        for example_id in examples:
            result_path = os.path.join(
                result_dir,
                "pyautogui",
                "screenshot",
                "claude-sonnet-4-5",  # Model name from args
                domain,
                example_id,
                "result.txt"
            )
            if os.path.exists(result_path):
                completed.append(f"{domain}/{example_id}")
                logger.info(f"Task {domain}/{example_id} already completed (result found)")

    return completed


def report_current_results(target_dir: str) -> List[float]:
    """Report current results from completed tasks.

    Args:
        target_dir: Directory containing results

    Returns:
        List of scores (0.0 or 1.0)
    """
    all_result = []

    for domain in os.listdir(target_dir):
        domain_path = os.path.join(target_dir, domain)
        if os.path.isdir(domain_path):
            for example_id in os.listdir(domain_path):
                example_path = os.path.join(domain_path, example_id)
                if os.path.isdir(example_path):
                    if "result.txt" in os.listdir(example_path):
                        try:
                            with open(os.path.join(example_path, "result.txt"), "r") as f:
                                all_result.append(float(f.read()))
                        except Exception as e:
                            logger.warning(f"Failed to read result for {domain}/{example_id}: {e}")
                            all_result.append(0.0)

    if not all_result:
        logger.info("New experiment, no results yet.")
        return None
    else:
        success_rate = sum(all_result) / len(all_result) * 100
        logger.info(f"Current Success Rate: {success_rate:.2f}% ({len(all_result)} tasks)")
        return all_result


def distribute_tasks(test_all_meta: dict) -> List[tuple]:
    all_tasks = []
    for domain, examples in test_all_meta.items():
        for example_id in examples:
            all_tasks.append((domain, example_id))
    return all_tasks


def process_signal_handler(signum, frame, env_idx):
    """Signal handler for child processes to gracefully shut down their environments."""
    logger.info(f"Process {env_idx + 1} received signal {signum}. Shutting down...")

    # Get the active_environments from the caller's frame
    local_vars = frame.f_locals
    active_environments = local_vars.get('active_environments', [])

    # Close environment in the current process context
    for env in active_environments:
        if env is not None:
            try:
                logger.info(f"Process {env_idx + 1} closing environment...")
                env.close()
                logger.info(f"Process {env_idx + 1} environment closed successfully")
            except Exception as e:
                logger.error(f"Process {env_idx + 1} error closing environment: {e}")

    logger.info(f"Process {env_idx + 1} shutdown complete. Exiting.")
    sys.exit(0)


def run_env_tasks(task_queue, args: argparse.Namespace, shared_scores: list):
    """Worker process that runs tasks from the queue using hosted GBOX service."""
    active_environments = []
    env = None
    try:
        from desktop_env.providers.aws.manager import IMAGE_ID_MAP
        REGION = args.region
        screen_size = (args.screen_width, args.screen_height)
        ami_id = IMAGE_ID_MAP[REGION].get(screen_size, IMAGE_ID_MAP[REGION][(1920, 1080)])

        # Create environment
        env = DesktopEnv(
            path_to_vm=args.path_to_vm,
            action_space=args.action_space,
            provider_name=args.provider_name,
            region=REGION,
            snapshot_name=ami_id,
            screen_size=screen_size,
            headless=args.headless,
            os_type="Ubuntu",
            require_a11y_tree=args.observation_type in ["a11y_tree", "screenshot_a11y_tree", "som"],
            enable_proxy=True,
            client_password=args.client_password
        )
        active_environments.append(env)

        # Get VM IP address - MCP server will handle public IP lookup if needed
        vm_ip = env.vm_ip
        logger.info(f"VM IP: {vm_ip}")

        # Create hosted GBOX agent
        agent = HostedGboxAgent(
            server_url=args.gbox_service_url,
            api_key=args.gbox_service_api_key,
            vm_ip=vm_ip,
            platform="ubuntu",
            model=args.model,
            max_steps=args.max_steps,
        )

        # Process tasks from queue
        while True:
            try:
                item = task_queue.get(timeout=5)
            except Exception:
                break

            domain, example_id = item
            try:
                config_file = os.path.join(
                    args.test_config_base_dir, f"examples/{domain}/{example_id}.json"
                )
                with open(config_file, "r", encoding="utf-8") as f:
                    example = json.load(f)

                logger.info(f"[Domain]: {domain}")
                logger.info(f"[Example ID]: {example_id}")
                logger.info(f"[Instruction]: {example['instruction']}")

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
                    lib_run_single.run_single_example(
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
                    import traceback
                    logger.error(f"Exception {domain}/{example_id}: {e}")
                    logger.error(traceback.format_exc())
                    try:
                        env.controller.end_recording(
                            os.path.join(example_result_dir, "recording.mp4")
                        )
                    except Exception as rec_e:
                        logger.error(f"Failed to end recording: {rec_e}")
                    with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                        f.write(
                            json.dumps(
                                {"Error": f"{domain}/{example_id} - {e}"}
                            )
                        )
                        f.write("\n")
            except Exception as e:
                logger.error(f"Error processing task: {e}", exc_info=True)

    except KeyboardInterrupt:
        logger.info("Worker received interrupt signal")
    except Exception as e:
        logger.error(f"Worker error: {e}", exc_info=True)
    finally:
        # Cleanup
        if env is not None:
            try:
                logger.info("Closing environment...")
                env.close()
                logger.info("Environment closed successfully")
            except Exception as e:
                logger.error(f"Error closing environment: {e}")


def main_signal_handler(signum, frame):
    """Signal handler for main process to gracefully shut down all child processes."""
    global is_terminating
    if is_terminating:
        logger.info("Already terminating, please wait...")
        return

    is_terminating = True
    logger.info(f"Main process received signal {signum}. Shutting down all workers...")

    # Terminate all child processes
    for idx, proc in enumerate(processes):
        if proc.is_alive():
            logger.info(f"Terminating worker process {idx + 1}...")
            proc.terminate()

    # Wait for processes to finish with timeout
    timeout = 30
    start_time = time.time()
    for idx, proc in enumerate(processes):
        remaining_time = max(0, timeout - (time.time() - start_time))
        proc.join(timeout=remaining_time)
        if proc.is_alive():
            logger.warning(f"Worker {idx + 1} did not terminate gracefully, forcing...")
            proc.kill()
            proc.join()

    logger.info("All workers terminated. Exiting.")
    sys.exit(0)


if __name__ == "__main__":
    args = config()

    # Setup main logger
    logger = setup_logger(env_idx=None, result_dir=args.result_dir, level=args.log_level)

    # Validate hosted service configuration
    if not args.gbox_service_url:
        logger.error("GBOX_SERVICE_URL not set (use --gbox_service_url or GBOX_SERVICE_URL env var)")
        sys.exit(1)

    if not args.gbox_service_api_key:
        logger.error("GBOX_SERVICE_API_KEY not set (use --gbox_service_api_key or GBOX_SERVICE_API_KEY env var)")
        sys.exit(1)

    logger.info(f"Using hosted GBOX service at: {args.gbox_service_url}")
    logger.info(f"Model: {args.model}")
    logger.info(f"Max steps: {args.max_steps}")
    logger.info(f"Number of parallel environments: {args.num_envs}")

    # Setup signal handlers
    signal.signal(signal.SIGINT, main_signal_handler)
    signal.signal(signal.SIGTERM, main_signal_handler)

    # Load test configuration
    logger.info(f"Loading test configuration from: {args.test_all_meta_path}")
    with open(args.test_all_meta_path, "r") as f:
        test_all_meta = json.load(f)

    # Filter by domain if specified
    if args.domain != "all":
        if args.domain in test_all_meta:
            test_all_meta = {args.domain: test_all_meta[args.domain]}
            logger.info(f"Filtering to domain: {args.domain}")
        else:
            logger.error(f"Domain '{args.domain}' not found in test configuration")
            sys.exit(1)

    # Check for completed tasks
    completed_tasks = check_completed_tasks(args.result_dir, test_all_meta)
    logger.info(f"Found {len(completed_tasks)} completed tasks")

    # Distribute tasks
    all_tasks = distribute_tasks(test_all_meta)
    logger.info(f"Total tasks to run: {len(all_tasks)}")

    # Filter out completed tasks
    all_tasks = [task for task in all_tasks if f"{task[0]}/{task[1]}" not in completed_tasks]
    logger.info(f"Tasks remaining after filtering completed: {len(all_tasks)}")

    if not all_tasks:
        logger.info("No tasks to run. All tasks already completed.")

        # Report current results
        target_dir = os.path.join(
            args.result_dir,
            args.action_space,
            args.observation_type,
            args.model if getattr(args, 'model_dir_name', None) is None else args.model_dir_name
        )
        if os.path.exists(target_dir):
            report_current_results(target_dir)

        sys.exit(0)

    # Create shared task queue
    manager = Manager()
    task_queue = manager.Queue()
    shared_scores = manager.list()

    # Populate queue
    for task in all_tasks:
        task_queue.put(task)

    # Start worker processes
    logger.info(f"Starting {args.num_envs} worker processes...")
    for env_idx in range(args.num_envs):
        proc = Process(
            target=run_env_tasks,
            args=(task_queue, args, shared_scores)
        )
        proc.start()
        processes.append(proc)
        logger.info(f"Started worker process {env_idx + 1} (PID: {proc.pid})")

    # Wait for all processes to complete
    try:
        for idx, proc in enumerate(processes):
            proc.join()
            logger.info(f"Worker process {idx + 1} completed")
    except KeyboardInterrupt:
        logger.info("Received interrupt, shutting down...")
        main_signal_handler(signal.SIGINT, None)

    # Report final results
    logger.info("=" * 50)
    logger.info("EVALUATION COMPLETE")
    logger.info("=" * 50)

    target_dir = os.path.join(
        args.result_dir,
        args.action_space,
        args.observation_type,
        args.model
    )

    if os.path.exists(target_dir):
        final_results = report_current_results(target_dir)
        if final_results:
            success_rate = sum(final_results) / len(final_results) * 100
            logger.info(f"Final Success Rate: {success_rate:.2f}% ({len(final_results)} tasks)")

    logger.info("Exiting...")
