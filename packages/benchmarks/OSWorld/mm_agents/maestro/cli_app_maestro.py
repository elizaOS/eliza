import argparse
from ast import arg
import datetime
import io
import logging
import os
import platform
import sys
import time
from pathlib import Path
from dotenv import load_dotenv
from PIL import Image
from gui_agents.maestro.controller.main_controller import MainController
# Import analyze_display functionality
from gui_agents.utils.analyze_display import analyze_display_json, aggregate_results, format_output_line
from gui_agents.utils.common_utils import show_task_completion_notification
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

datetime_str: str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

log_dir = "runtime"
os.makedirs(os.path.join(log_dir, datetime_str), exist_ok=True)

file_handler = logging.FileHandler(
    os.path.join(log_dir, datetime_str, "agents3.log"), encoding="utf-8"
)
debug_handler = logging.FileHandler(
    os.path.join(log_dir, datetime_str, "agents3_debug.log"), encoding="utf-8"
)
stdout_handler = logging.StreamHandler(sys.stdout)

# Add dedicated doubao API log handler
doubao_handler = logging.FileHandler(
    os.path.join(log_dir, datetime_str, "doubao_api.log"), encoding="utf-8"
)

# Create dedicated doubao API logger
doubao_logger = logging.getLogger("doubao_api")
doubao_logger.setLevel(logging.DEBUG)
doubao_logger.addHandler(doubao_handler)

file_handler.setLevel(logging.INFO)
debug_handler.setLevel(logging.DEBUG)
stdout_handler.setLevel(logging.INFO)
doubao_handler.setLevel(logging.DEBUG)

# Add SafeLoggingFilter to prevent format errors from third-party libraries (like OpenAI)
safe_filter = SafeLoggingFilter()
debug_handler.addFilter(safe_filter)

# Also apply SafeLoggingFilter to OpenAI library loggers
try:
    import openai
    openai_logger = logging.getLogger('openai')
    openai_logger.addFilter(safe_filter)
    httpx_logger = logging.getLogger('httpx')
    httpx_logger.addFilter(safe_filter)
    logger.info("SafeLoggingFilter applied to third-party libraries (OpenAI, HTTPX)")
except ImportError:
    logger.info("SafeLoggingFilter applied to main handlers only (OpenAI not available)")
    pass

if os.getenv('KEEP_IMAGE_LOGS', 'false').lower() != 'true':
    image_filter = ImageDataFilter()
    debug_handler.addFilter(image_filter)
    logger.info("Image data filtering enabled - image data in debug logs will be filtered")
else:
    logger.info("Image data filtering disabled - debug logs will contain complete image data")

formatter = logging.Formatter(
    fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
)
file_handler.setFormatter(formatter)
debug_handler.setFormatter(formatter)
stdout_handler.setFormatter(formatter)
doubao_handler.setFormatter(formatter)

logger.addHandler(file_handler)
logger.addHandler(debug_handler)
logger.addHandler(stdout_handler)


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
                
                # Also print to console for immediate visibility
                print("\n" + "=" * 80)
                print("EXECUTION STATISTICS:")
                print("Steps, Duration (seconds), (Input Tokens, Output Tokens, Total Tokens), Cost")
                print("=" * 80)
                print(output_line)
                print("=" * 80)
            else:
                logger.warning("No valid data found in display.json for analysis")
        else:
            logger.warning(f"Display.json file not found at: {display_json_path} after waiting {max_wait_time} seconds")
            
    except Exception as e:
        logger.error(f"Error during auto-analysis: {e}")


def run_agent_maestro(params: dict):
    """
    Run the maestro controller with the given instruction
    
    Args:
        controller: The NewController instance to run
        instruction: The instruction/task to execute
        max_steps: Maximum number of steps to execute
    """

    backend = params["backend"]
    user_query = params["query"]
    max_steps = params["max_steps"]
    current_platform = params["current_platform"]
    env = params["env"]
    env_password = params["env_password"]

    import time
    
    logger.info(f"Starting maestro execution with instruction: {user_query}")
    
    total_start_time = time.time()
    # Ensure necessary directory structure exists
    timestamp_dir = os.path.join(log_dir, datetime_str)
    cache_dir = os.path.join(timestamp_dir, "cache", "screens")
    state_dir = os.path.join(timestamp_dir, "state")

    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(state_dir, exist_ok=True)

    # registry = Registry(global_state)

    # Initialize NewController (which includes all other components)
    controller = MainController(
        platform=current_platform,
        backend=backend,
        user_query=user_query,
        max_steps=max_steps,
        env=env,
        env_password=env_password,
        log_dir=log_dir,
        datetime_str=datetime_str
    )
    
    try:
        # Set the user query in the controller
        controller.execute_main_loop()
        
        # Check task status after execution to determine if task was successful
        task = controller.global_state.get_task()
        if task and task.status == "fulfilled":
            # Task completed successfully
            logger.info("Task completed successfully")
            show_task_completion_notification("success")
        elif task and task.status == "rejected":
            # Task was rejected/failed
            logger.info("Task was rejected/failed")
            show_task_completion_notification("failed")
        else:
            # Task status unknown or incomplete
            logger.info("Task execution completed with unknown status")
            show_task_completion_notification("completed")
        
    except Exception as e:
        logger.error(f"Error during maestro execution: {e}")
        # Show error notification
        show_task_completion_notification("error", str(e))
        raise
    
    finally:
        total_end_time = time.time()
        total_duration = total_end_time - total_start_time
        logger.info(f"Total execution time: {total_duration:.2f} seconds")
        
        # Auto-analyze execution statistics after task completion
        auto_analyze_execution(timestamp_dir)


def main():
    parser = argparse.ArgumentParser(description='Maestro CLI Application')
    parser.add_argument(
        '--backend',
        type=str,
        default='lybic',
        help='Backend to use (e.g., lybic, pyautogui, pyautogui_vmware)')
    parser.add_argument('--query',
                        type=str,
                        default='',
                        help='Initial query to execute')
    parser.add_argument('--max-steps',
                        type=int,
                        default=50,
                        help='Maximum number of steps to execute (default: 50)')
    parser.add_argument(
        '--lybic-sid',
        type=str,
        default=None,
        help='Lybic precreated sandbox ID (if not provided, will use LYBIC_PRECREATE_SID environment variable)')
    args = parser.parse_args()

    env = None
    env_password = ""

    # Set platform to Windows if backend is lybic
    if args.backend == 'lybic':
        current_platform = 'Windows'
        # Initialize hardware interface
        backend_kwargs = {"platform": current_platform}
        if args.lybic_sid is not None:
            backend_kwargs["precreate_sid"] = args.lybic_sid
            logger.info(f"Using Lybic SID from command line: {args.lybic_sid}")
        else:
            logger.info("Using Lybic SID from environment variable LYBIC_PRECREATE_SID")

    elif args.backend == 'pyautogui_vmware':
        env_password = "password"
        current_platform = os.getenv("USE_PRECREATE_VM", "Windows")
        if current_platform == "Ubuntu":
            path_to_vm = os.path.join("vmware_vm_data", "Ubuntu0", "Ubuntu0.vmx")
        elif current_platform == "Windows":
            path_to_vm = os.path.join("vmware_vm_data", "Windows0", "Windows0.vmx")
        else:
            raise ValueError(f"USE_PRECREATE_VM={current_platform} is not supported. Please use Ubuntu or Windows.")

        env = DesktopEnv(
            path_to_vm=path_to_vm,
            provider_name="vmware", 
            os_type=current_platform, 
            action_space="pyautogui",
            require_a11y_tree=False
        )
        env.reset()

    else:
        current_platform = platform.system()

    logger.info(f"Running maestro on platform: {current_platform}")
    logger.info(f"Using backend: {args.backend}")

    logger.info("Maestro components initialized successfully")            

    params = {
        "backend": args.backend,
        "query": '',
        "max_steps": args.max_steps,
        "current_platform": current_platform,
        "env": env,
        "env_password": env_password
    }
    # if query is provided, run the agent on the query
    if args.query:
        logger.info(f"Executing query: {args.query}")
        params["query"] = args.query
        run_agent_maestro(params)

    else:
        while True:
            query = input("Query: ")
            params["query"] = query
            # Run the agent on your own device
            run_agent_maestro(params)

            response = input("Would you like to provide another query? (y/n): ")
            if response.lower() != "y":
                break


if __name__ == "__main__":
    """
    python gui_agents/cli_app_maestro.py --backend lybic
    python gui_agents/cli_app_maestro.py --backend pyautogui --max-steps 1
    python gui_agents/cli_app_maestro.py --backend pyautogui_vmware --max-steps 1
    python gui_agents/cli_app_maestro.py --backend lybic --max-steps 15
    python gui_agents/cli_app_maestro.py --backend lybic --lybic-sid SBX-01K1X6ZKAERXAN73KTJ1XXJXAF
    """
    main()