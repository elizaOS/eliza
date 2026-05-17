import argparse
import json
import datetime
import logging
import os
import sys
import time
import traceback
from pathlib import Path
from tqdm import tqdm
from dotenv import load_dotenv
from multiprocessing import Pool, cpu_count
from functools import partial
from desktop_env.desktop_env import DesktopEnv

# Add project root to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))


# Import from local mm_agents/maestro
try:
    from mm_agents.maestro.maestro.controller.main_controller import MainController
    from mm_agents.maestro.utils.analyze_display import analyze_display_json, format_output_line
    from mm_agents.maestro.utils.common_utils import ImageDataFilter, SafeLoggingFilter
except Exception as e:
    raise ImportError(
        f"Failed to import maestro dependencies, please ensure mm_agents/maestro directory exists. Reason: {e}"
    )

# Load .env from mm_agents/maestro directory
CURRENT_FILE = Path(__file__).resolve()
PROJECT_ROOT = CURRENT_FILE.parent
MAESTRO_ENV_PATH = PROJECT_ROOT / "mm_agents" / "maestro" / ".env"
if MAESTRO_ENV_PATH.exists():
    load_dotenv(dotenv_path=MAESTRO_ENV_PATH)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

vm_datetime_str: str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

log_dir = "runtime"
vm_log_dir = os.path.join(log_dir, f"awsrun_{vm_datetime_str}")
os.makedirs(vm_log_dir, exist_ok=True)

file_handler = logging.FileHandler(
    os.path.join(vm_log_dir, "awsrun_normal.log"), encoding="utf-8"
)
debug_handler = logging.FileHandler(
    os.path.join(vm_log_dir, "awsrun_debug.log"), encoding="utf-8"   
)
stdout_handler = logging.StreamHandler(sys.stdout)
sdebug_handler = logging.FileHandler(
    os.path.join(vm_log_dir, "awsrun_sdebug.log"), encoding="utf-8"
)

file_handler.setLevel(logging.INFO)
debug_handler.setLevel(logging.INFO)
stdout_handler.setLevel(logging.INFO)
sdebug_handler.setLevel(logging.INFO)

# Safe logging filter
safe_filter = SafeLoggingFilter()
debug_handler.addFilter(safe_filter)
sdebug_handler.addFilter(safe_filter)
file_handler.addFilter(safe_filter)
stdout_handler.addFilter(safe_filter)

# Try to filter third-party library logs
try:
    import openai  # noqa: F401
    openai_logger = logging.getLogger('openai')
    openai_logger.addFilter(safe_filter)
    httpx_logger = logging.getLogger('httpx')
    httpx_logger.addFilter(safe_filter)
except Exception:
    pass

if os.getenv('KEEP_IMAGE_LOGS', 'false').lower() != 'true':
    image_filter = ImageDataFilter()
    debug_handler.addFilter(image_filter)
    sdebug_handler.addFilter(image_filter)
    logging.getLogger().info("Image data filtering enabled - image data in debug logs will be filtered")
else:
    logging.getLogger().info("Image data filtering disabled - debug logs will contain complete image data")

logging.getLogger().info("Safe logging filter enabled - prevents format errors from third-party libraries (OpenAI, HTTPX)")

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

logger = logging.getLogger("desktopenv.experiment")


def config() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run end-to-end evaluation on the benchmark (maestro integration)"
    )

    current_platform = "Ubuntu"
    test_config_base_dir = os.path.join("evaluation_examples", "examples")
    test_all_meta_path = os.path.join("evaluation_examples", "test_tiny.json")


    # platform config
    parser.add_argument(
        "--current_platform", 
        type=str, 
        choices=["Ubuntu", "Windows"], 
        default=current_platform,
        help="Platform to run on (Ubuntu or Windows)"
    )

    # environment config
    parser.add_argument("--headless", action="store_true", help="Run in headless machine")
    parser.add_argument("--action_space", type=str, default="pyautogui", help="Action type")
    parser.add_argument(
        "--observation_type",
        choices=["screenshot", "a11y_tree", "screenshot_a11y_tree", "som"],
        default="screenshot",
        help="Observation type",
    )
    parser.add_argument("--max_steps", type=int, default=50)

    # agent config
    parser.add_argument("--test_config_base_dir", type=str, default=test_config_base_dir)

    # password config
    parser.add_argument("--password", type=str, default="osworld-public-evaluation", help="Environment password for sudo operations")

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument("--test_all_meta_path", type=str, default=test_all_meta_path)

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results")
    parser.add_argument("--num_envs", type=int, default=1, help="Number of environments to run in parallel")

    args = parser.parse_args()

    # Convert to absolute paths to avoid cwd dependency
    try:
        repo_root = PROJECT_ROOT
        if not os.path.isabs(args.test_config_base_dir):
            args.test_config_base_dir = str((repo_root / args.test_config_base_dir).resolve())
        if not os.path.isabs(args.test_all_meta_path):
            args.test_all_meta_path = str((repo_root / args.test_all_meta_path).resolve())
    except Exception:
        pass

    return args


def process_with_delay_wrapper(task_with_index_and_args):
    task_info, task_index, args, vm_log_dir, base_timestamp = task_with_index_and_args
    time.sleep(task_index * 5)
    return process_single_task(task_info, args, vm_log_dir, base_timestamp, task_index)


def process_single_task_no_delay(task_with_index_and_args):
    """Worker function to process a single task without delay for queue mode"""
    task_info, task_index, args, vm_log_dir, base_timestamp = task_with_index_and_args
    return process_single_task(task_info, args, vm_log_dir, base_timestamp, task_index)


def process_single_task(task_info, args, vm_log_dir, base_timestamp=None, task_index=0):
    """Worker function to process a single task"""
    domain, example_id, config_file = task_info
    
    try:
        with open(config_file, "r", encoding="utf-8") as f:
            example = json.load(f)

        user_query = example["instruction"]
        
        if base_timestamp:
            example_datetime_str = f"{base_timestamp}_{task_index:03d}"
        else:
            example_datetime_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:17]

        example_result_dir = os.path.join(
            args.result_dir,
            args.action_space,
            args.observation_type,
            domain,
            example_id,
        )
        os.makedirs(example_result_dir, exist_ok=True)

        try:
            run_single_example(
                None,
                example,
                user_query,
                args,
                example_result_dir,
                [],  # scores not needed in worker
                vm_log_dir,
                example_datetime_str,
            )
            
        except Exception as e:
            logger.error(f"Exception in {domain}/{example_id}: {e}")
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(
                    json.dumps(
                        {"Error": f"Time limit exceeded in {domain}/{example_id}"}
                    )
                )
                f.write("\n")
            result = 0.0
        finally:
            # env is created and managed within run_single_example
            pass
            
        
    except Exception as e:
        logger.error(f"Fatal error in task {domain}/{example_id}: {e}")
        traceback.print_exc()
        return domain, example_id, 0.0


def test(args: argparse.Namespace, test_all_meta: dict) -> None:
    scores = []

    logger.info("Args: %s", args)
    cfg_args = {
        "headless": args.headless,
        "action_space": args.action_space,
        "observation_type": args.observation_type,
        "max_steps": args.max_steps,
        "result_dir": args.result_dir,
    }

    # Prepare tasks list
    tasks = []
    for domain in test_all_meta:
        domain_sanitized = str(domain).strip()
        for example_id in test_all_meta[domain]:
            example_id_sanitized = str(example_id).strip()
            config_file = os.path.join(
                args.test_config_base_dir,
                domain_sanitized,
                f"{example_id_sanitized}.json"
            )

            if not os.path.exists(config_file):
                try:
                    candidate_dir = os.path.join(args.test_config_base_dir, domain_sanitized)
                    existing_files = []
                    if os.path.isdir(candidate_dir):
                        existing_files = os.listdir(candidate_dir)
                    logger.error(f"Config file not found: {config_file}")
                    logger.error(f"Existing files in {candidate_dir}: {existing_files}")
                except Exception as e:
                    logger.error(f"Error while listing directory for debug: {e}")
                raise FileNotFoundError(config_file)

            tasks.append((domain_sanitized, example_id_sanitized, config_file))

    if args.num_envs > 1:
        # Parallel processing with task queue - fixed number of workers
        num_workers = args.num_envs
        logger.info(f"Processing {len(tasks)} tasks with {num_workers} workers in queue mode...")
        
        # Process tasks with fixed worker pool - tasks will queue and wait for available workers
        with Pool(processes=num_workers) as pool:
            results = []
            for i, task in enumerate(tasks):
                base_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                # Add 5 second delay between task submissions
                if i > 0:
                    time.sleep(5)
                
                task_with_args = (task, i, args, vm_log_dir, base_timestamp)
                result = pool.apply_async(process_single_task_no_delay, (task_with_args,))
                results.append(result)
                logger.info(f"Submitted task {i+1}/{len(tasks)}: {task[0]}/{task[1]}")
            
            # Wait for all tasks to complete
            final_results = [result.get() for result in results]
            
    else:
        # Sequential processing (original logic)
        for domain, example_id, config_file in tqdm(tasks, desc="Processing tasks"):
            logger.info(f"[Domain]: {domain}")
            logger.info(f"[Example ID]: {example_id}")

            with open(config_file, "r", encoding="utf-8") as f:
                example = json.load(f)

            user_query = example["instruction"]
            logger.info(f"[User Query]: {user_query}")
            
            cfg_args["user_query"] = user_query
            cfg_args["start_time"] = datetime.datetime.now().strftime(
                "%Y:%m:%d-%H:%M:%S"
            )

            example_datetime_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

            example_result_dir = os.path.join(
                args.result_dir,
                args.action_space,
                args.observation_type,
                domain,
                example_id,
            )
            os.makedirs(example_result_dir, exist_ok=True)

            try:
                run_single_example(
                    None,  # env will be created in run_single_example for sequential mode
                    example,
                    user_query,
                    args,
                    example_result_dir,
                    scores,
                    vm_log_dir,
                    example_datetime_str,
                )
            except Exception as e:
                logger.error(f"Exception in {domain}/{example_id}: {e}")
                # Note: env creation moved to run_single_example for sequential mode


def run_single_example(
    env: DesktopEnv | None,
    example,
    user_query: str,
    args,
    example_result_dir,
    scores,
    vm_log_dir: str,
    example_datetime_str: str,
):
    example_timestamp_dir = os.path.join(vm_log_dir, example_datetime_str)
    total_start_time = time.time()
    cache_dir = os.path.join(example_timestamp_dir, "cache", "screens")
    state_dir = os.path.join(example_timestamp_dir, "state")

    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(state_dir, exist_ok=True)

    example_logger = setup_example_logger(example, example_timestamp_dir)
    example_logger.info(f"Starting example {example.get('id', 'unknown')}")
    example_logger.info(f"User Query: {user_query}")
    
    # Create environment if not provided (for sequential mode)
    if env is None:
        # Read proxy setting from example config, default to False if not specified
        enable_proxy = example.get("proxy", False)
        logger.info(f"Proxy status: {enable_proxy}")
        env = DesktopEnv(
            provider_name="aws",
            region="us-east-1",
            action_space=args.action_space,
            headless=args.headless,
            require_a11y_tree=False,
            enable_proxy=enable_proxy
        )
    
    env.reset(task_config=example)

    controller = MainController(
        platform=args.current_platform,
        backend="pyautogui_vmware",
        user_query=user_query,
        max_steps=args.max_steps,
        env=env,
        env_password=args.password,
        log_dir=vm_log_dir,
        datetime_str=example_datetime_str,
    )

    try:
        controller.execute_main_loop()
        task = controller.global_state.get_task()
        if task and task.status == "fulfilled":
            logger.info("Task completed successfully")
            env.step("DONE")
        elif task and task.status == "rejected":
            logger.info("Task was rejected/failed")
            env.step("FAIL")
        else:
            logger.info("Task execution completed with unknown status")
            env.step("DONE")
        
        # Retry mechanism for evaluate method
        max_retries = 3
        retry_delay = 5  # seconds
        result = 0
        
        for attempt in range(max_retries):
            try:
                result = env.evaluate()
                logger.info("Result: %.2f", result)
                example_logger.info("Result: %.2f", result)
                example_logger.info(f"Example {example.get('id', 'unknown')} completed with result: {result}")
                break  # Success, exit retry loop
            except Exception as e:
                logger.warning(f"Evaluate attempt {attempt + 1}/{max_retries} failed: {e}")
                if attempt < max_retries - 1:  # Not the last attempt
                    logger.info(f"Waiting {retry_delay} seconds before retry...")
                    time.sleep(retry_delay)
                else:
                    logger.error("All evaluate attempts failed, setting result to 0")
                    result = 0
                    example_logger.info("Result: %.2f", result)
                    example_logger.info(f"Example {example.get('id', 'unknown')} completed with result: {result} (after failed retries)")
        scores.append(result)
        with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
            f.write(f"{result}\n")

    except Exception as e:
        logger.error(f"Error during maestro execution: {e}")
        raise
    finally:
        total_end_time = time.time()
        total_duration = total_end_time - total_start_time
        logger.info(f"Total execution time: {total_duration:.2f} seconds")
        auto_analyze_execution(example_timestamp_dir)
        
        env.close()


def auto_analyze_execution(timestamp_dir: str):
    import time as _t
    try:
        display_json_path = os.path.join(timestamp_dir, "display.json")
        max_wait_time = 10
        wait_interval = 0.5
        waited_time = 0
        while waited_time < max_wait_time:
            if os.path.exists(display_json_path):
                try:
                    size1 = os.path.getsize(display_json_path)
                    _t.sleep(wait_interval)
                    size2 = os.path.getsize(display_json_path)
                    if size1 == size2:
                        logger.info(f"Display.json file appears to be complete (size: {size1} bytes)")
                        break
                    else:
                        logger.info(f"Display.json file still being written (size changed from {size1} to {size2} bytes)")
                        waited_time += wait_interval
                        continue
                except OSError:
                    _t.sleep(wait_interval)
                    waited_time += wait_interval
                    continue
            else:
                logger.info(f"Waiting for display.json file to be created... ({waited_time:.1f}s)")
                _t.sleep(wait_interval)
                waited_time += wait_interval
        if os.path.exists(display_json_path):
            logger.info(f"Auto-analyzing execution statistics from: {display_json_path}")
            result = analyze_display_json(display_json_path)
            if result:
                output_line = format_output_line(result)
                logger.info("=" * 80)
                logger.info("EXECUTION STATISTICS:")
                logger.info("Steps, Duration (seconds), (Input Tokens, Output Tokens, Total Tokens), Cost")
                logger.info("=" * 80)
                logger.info(output_line)
                logger.info("=" * 80)
            else:
                logger.warning("No valid data found in display.json for analysis")
        else:
            logger.warning(f"Display.json file not found at: {display_json_path} after waiting {max_wait_time} seconds")
    except Exception as e:
        logger.error(f"Error during auto-analysis: {e}")


def setup_example_logger(example, example_timestamp_dir):
    example_id = example.get('id', 'unknown')
    example_logger = logging.getLogger(f"example.{example_id}.{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}")
    example_logger.setLevel(logging.DEBUG)

    example_logger.handlers.clear()

    log_file = os.path.join(example_timestamp_dir, "example.log")
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)

    debug_log_file = os.path.join(example_timestamp_dir, "example_debug.log")
    debug_handler = logging.FileHandler(debug_log_file, encoding="utf-8")
    debug_handler.setLevel(logging.DEBUG)

    formatter = logging.Formatter(
        fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
    )
    file_handler.setFormatter(formatter)
    debug_handler.setFormatter(formatter)

    example_logger.addHandler(file_handler)
    example_logger.addHandler(debug_handler)

    return example_logger

def get_unfinished(
    action_space, observation_type, result_dir, total_file_json
):
    target_dir = os.path.join(result_dir, action_space, observation_type)

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

if __name__ == "__main__":
    """
    xvfb-run -a python run_maestro.py --test_all_meta_path evaluation_examples/test_nogdrive.json --num_envs 1 --headless --result_dir ./results_maestro_debug
    """

    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    args = config()

    with open(args.test_all_meta_path, "r", encoding="utf-8") as f:
        test_all_meta = json.load(f)

    if args.domain != "all":
        test_all_meta = {args.domain: test_all_meta[args.domain]}

    test_file_list = get_unfinished(
        args.action_space,
        args.observation_type,
        args.result_dir,
        test_all_meta,
    )

    left_info = ""
    for domain in test_file_list:
        left_info += f"{domain}: {len(test_file_list[domain])}\n"
    logger.info(f"Left tasks:\n{left_info}")

    test(args, test_file_list)