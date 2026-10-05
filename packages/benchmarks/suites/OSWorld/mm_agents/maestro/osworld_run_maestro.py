import argparse
import json
import datetime
import io
import logging
import os
import platform
import sys
import time
from tqdm import tqdm
from pathlib import Path
from dotenv import load_dotenv
from gui_agents.maestro.controller.main_controller import MainController
# Import analyze_display functionality
from gui_agents.utils.analyze_display import analyze_display_json, format_output_line
from desktop_env.desktop_env import DesktopEnv
from gui_agents.utils.common_utils import ImageDataFilter, SafeLoggingFilter

env_path = Path(os.path.dirname(os.path.abspath(__file__))) / '.env'
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    parent_env_path = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / '.env'
    if parent_env_path.exists():
        load_dotenv(dotenv_path=parent_env_path)

logger = logging.getLogger()
logger.setLevel(logging.DEBUG)

vm_datetime_str: str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

log_dir = "runtime"
vm_log_dir = os.path.join(log_dir, f"vmrun_{vm_datetime_str}")
os.makedirs(vm_log_dir, exist_ok=True)

file_handler = logging.FileHandler(
    os.path.join(vm_log_dir, "vmrun_normal.log"), encoding="utf-8"
)
debug_handler = logging.FileHandler(
    os.path.join(vm_log_dir, "vmrun_debug.log"), encoding="utf-8"   
)
stdout_handler = logging.StreamHandler(sys.stdout)
sdebug_handler = logging.FileHandler(
    os.path.join(vm_log_dir, "vmrun_sdebug.log"), encoding="utf-8"
)

file_handler.setLevel(logging.INFO)
debug_handler.setLevel(logging.DEBUG)
stdout_handler.setLevel(logging.INFO)
sdebug_handler.setLevel(logging.DEBUG)

# Add SafeLoggingFilter to prevent format errors from third-party libraries (like OpenAI)
safe_filter = SafeLoggingFilter()
debug_handler.addFilter(safe_filter)
sdebug_handler.addFilter(safe_filter)
file_handler.addFilter(safe_filter)
stdout_handler.addFilter(safe_filter)

# Also apply SafeLoggingFilter to OpenAI library loggers
try:
    import openai
    openai_logger = logging.getLogger('openai')
    openai_logger.addFilter(safe_filter)
    httpx_logger = logging.getLogger('httpx')
    httpx_logger.addFilter(safe_filter)
except ImportError:
    pass

if os.getenv('KEEP_IMAGE_LOGS', 'false').lower() != 'true':
    image_filter = ImageDataFilter()
    debug_handler.addFilter(image_filter)
    sdebug_handler.addFilter(image_filter)
    logger.info("Image data filtering enabled - image data in debug logs will be filtered")
else:
    logger.info("Image data filtering disabled - debug logs will contain complete image data")

logger.info("Safe logging filter enabled - prevents format errors from third-party libraries (OpenAI, HTTPX)")

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
        description="Run end-to-end evaluation on the benchmark"
    )

    current_platform = os.getenv("USE_PRECREATE_VM", "Windows")
    if current_platform == "Ubuntu":
        path_to_vm = os.path.join("vmware_vm_data", "Ubuntu0", "Ubuntu0.vmx")
        test_config_base_dir = os.path.join("evaluation_examples", "examples")
        test_all_meta_path = os.path.join("evaluation_examples", "test_tiny.json")
    elif current_platform == "Windows":
        path_to_vm = os.path.join("vmware_vm_data", "Windows0", "Windows0.vmx")
        test_config_base_dir = os.path.join("evaluation_examples", "examples_windows")
        test_all_meta_path = os.path.join("evaluation_examples", "test_tiny_windows.json")
    else:
        raise ValueError(f"USE_PRECREATE_VM={current_platform} is not supported. Please use Ubuntu or Windows.")
    
    # platform config
    parser.add_argument(
        "--current_platform", 
        type=str, 
        choices=["Ubuntu", "Windows"], 
        default=current_platform,
        help="Platform to run on (Ubuntu or Windows)"
    )

    # environment config
    # vm_path will be set based on platform
    parser.add_argument("--path_to_vm", type=str, default=path_to_vm)
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
    parser.add_argument("--max_steps", type=int, default=50)

    # agent config
    parser.add_argument(
        "--test_config_base_dir", type=str, default=test_config_base_dir
    )

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument(
        "--test_all_meta_path", type=str, default=test_all_meta_path
    )

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results")

    args = parser.parse_args()

    return args


def test(args: argparse.Namespace, test_all_meta: dict) -> None:
    scores = []

    # log args
    logger.info("Args: %s", args)
    cfg_args = {
        "path_to_vm": args.path_to_vm,
        "headless": args.headless,
        "action_space": args.action_space,
        "observation_type": args.observation_type,
        "max_steps": args.max_steps,
        "result_dir": args.result_dir,
    }

    env = DesktopEnv(
        provider_name="vmware",
        path_to_vm=args.path_to_vm,
        action_space=args.action_space,
        headless=args.headless,
        require_a11y_tree=False,
    )

    for domain in tqdm(test_all_meta, desc="Domain"):
        domain_sanitized = str(domain).strip()
        for example_id in tqdm(test_all_meta[domain], desc="Example", leave=False):
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

            with open(config_file, "r", encoding="utf-8") as f:
                example = json.load(f)

            logger.info(f"[Domain]: {domain_sanitized}")
            logger.info(f"[Example ID]: {example_id_sanitized}")

            user_query = example["instruction"]

            logger.info(f"[User Query]: {user_query}")
            # wandb each example config settings
            cfg_args["user_query"] = user_query
            cfg_args["start_time"] = datetime.datetime.now().strftime(
                "%Y:%m:%d-%H:%M:%S"
            )

            # Create a separate timestamp folder for each example
            example_datetime_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            
            example_result_dir = os.path.join(
                args.result_dir,
                args.action_space,
                args.observation_type,
                domain,
                example_id,
            )
            os.makedirs(example_result_dir, exist_ok=True)
            # example start running
            try:
                run_single_example(
                    env,
                    example,
                    user_query,
                    args,
                    example_result_dir,
                    scores,
                    vm_log_dir,  # Pass the timestamp directory to run_single_example
                    example_datetime_str
                )
            except Exception as e:
                logger.error(f"Exception in {domain}/{example_id}: {e}")
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
    if scores:
        logger.info(f"Average score: {sum(scores) / len(scores)}")
    else:
        logger.info("No scores recorded - no examples were completed")

def run_single_example(
    env: DesktopEnv, 
    example, 
    user_query: str, 
    args, 
    example_result_dir, 
    scores, 
    vm_log_dir: str, 
    example_datetime_str: str
):

    # Set up a separate logger for each example
    example_timestamp_dir = os.path.join(vm_log_dir, example_datetime_str)
    total_start_time = time.time()
    cache_dir = os.path.join(example_timestamp_dir, "cache", "screens")
    state_dir = os.path.join(example_timestamp_dir, "state")

    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(state_dir, exist_ok=True)

    example_logger = setup_example_logger(example, example_timestamp_dir)
    example_logger.info(f"Starting example {example.get('id', 'unknown')}")
    example_logger.info(f"User Query: {user_query}")
    env.reset(task_config=example)

    controller = MainController(
        platform=args.current_platform,
        backend="pyautogui_vmware",
        user_query=user_query,
        max_steps=args.max_steps,
        env=env,
        log_dir=vm_log_dir,
        datetime_str=example_datetime_str
    )

    env.controller.start_recording()

    try:
        # Set the user query in the controller
        controller.execute_main_loop()
        
        # Check task status after execution to determine if task was successful
        task = controller.global_state.get_task()
        if task and task.status == "fulfilled":
            # Task completed successfully
            logger.info("Task completed successfully")
            env.step("DONE")
        elif task and task.status == "rejected":
            # Task was rejected/failed
            logger.info("Task was rejected/failed")
            env.step("FAIL")
        else:
            # Task status unknown or incomplete
            logger.info("Task execution completed with unknown status")
            env.step("DONE")
        
    except Exception as e:
        logger.error(f"Error during maestro execution: {e}")
        raise
    
    finally:
        total_end_time = time.time()
        total_duration = total_end_time - total_start_time
        logger.info(f"Total execution time: {total_duration:.2f} seconds")
        
        # Auto-analyze execution statistics after task completion
        auto_analyze_execution(example_timestamp_dir)
    
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    example_logger.info("Result: %.2f", result)
    example_logger.info(f"Example {example.get('id', 'unknown')} completed with result: {result}")
    scores.append(result)
    with open(
        os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8"
    ) as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))

def auto_analyze_execution(timestamp_dir: str):
    """
    Automatically analyze execution statistics from display.json files after task completion
    
    Args:
        timestamp_dir: Directory containing the execution logs and display.json
    """
    import time
    
    try:
        # Analyze the display.json file for this execution
        display_json_path = os.path.join(timestamp_dir, "display.json")
        
        # Wait for file to be fully written
        max_wait_time = 10  # Maximum wait time in seconds
        wait_interval = 0.5  # Check every 0.5 seconds
        waited_time = 0
        
        while waited_time < max_wait_time:
            if os.path.exists(display_json_path):
                # Check if file is still being written by monitoring its size
                try:
                    size1 = os.path.getsize(display_json_path)
                    time.sleep(wait_interval)
                    size2 = os.path.getsize(display_json_path)
                    
                    # If file size hasn't changed in the last 0.5 seconds, it's likely complete
                    if size1 == size2:
                        logger.info(f"Display.json file appears to be complete (size: {size1} bytes)")
                        break
                    else:
                        logger.info(f"Display.json file still being written (size changed from {size1} to {size2} bytes)")
                        waited_time += wait_interval
                        continue
                except OSError:
                    # File might be temporarily inaccessible
                    time.sleep(wait_interval)
                    waited_time += wait_interval
                    continue
            else:
                logger.info(f"Waiting for display.json file to be created... ({waited_time:.1f}s)")
                time.sleep(wait_interval)
                waited_time += wait_interval
        
        if os.path.exists(display_json_path):
            logger.info(f"Auto-analyzing execution statistics from: {display_json_path}")
            
            # Analyze the single display.json file
            result = analyze_display_json(display_json_path)
            
            if result:
                # Format and log the statistics
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


def get_result(action_space, observation_type, result_dir, total_file_json):
    target_dir = os.path.join(result_dir, action_space, observation_type)
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
    """
    python gui_agents/osworld_run_maestro.py --max_steps 3
    python gui_agents/osworld_run_maestro.py --test_all_meta_path evaluation_examples/test_tiny-answer_question.json
    """
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    args = config()

    # Normalize to absolute paths to avoid relative path dependency on current working directory
    try:
        repo_root = Path(__file__).resolve().parents[1]
        if not os.path.isabs(args.test_config_base_dir):
            args.test_config_base_dir = str((repo_root / args.test_config_base_dir).resolve())
        if not os.path.isabs(args.test_all_meta_path):
            args.test_all_meta_path = str((repo_root / args.test_all_meta_path).resolve())
        if not os.path.isabs(args.path_to_vm):
            args.path_to_vm = str((repo_root / args.path_to_vm).resolve())
    except Exception:
        pass

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

    get_result(
        args.action_space,
        args.observation_type,
        args.result_dir,
        test_all_meta,
    )
    test(args, test_file_list)
