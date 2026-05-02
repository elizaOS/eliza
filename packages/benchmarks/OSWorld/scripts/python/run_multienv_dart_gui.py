# -*- coding: utf-8 -*-

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
from multiprocessing import Process, Manager, Queue
from multiprocessing import current_process

from numpy import True_

# Add project root to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import lib_run_single
from desktop_env.desktop_env import DesktopEnv
from mm_agents.dart_gui_agent import DartAgent
import os

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
        description="Run end-to-end evaluation on the benchmark - Dart Version"
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
    parser.add_argument("--sleep_after_execution", type=float, default=5.0)
    parser.add_argument("--max_steps", type=int, default=15)
    
    # evaluation config
    parser.add_argument(
        "--test_config_base_dir", type=str, default="evaluation_examples"
    )

    # lm config - Dart specific configurations
    parser.add_argument("--model", type=str, default="dart-uitars", help="Model name for Dart")
    parser.add_argument("--model_type", type=str, default="qwen25vl", choices=["qwen25vl", "qwen2vl"])
    parser.add_argument("--infer_mode", type=str, default="dart_mode", choices=["dart_mode", "qwen2vl_user"])
    parser.add_argument("--prompt_style", type=str, default="dart_style")
    parser.add_argument("--input_swap", action="store_true", help="Use copy and paste to type content")
    parser.add_argument("--language", type=str, default="English")
    parser.add_argument("--max_pixels", type=float, default=16384*28*28)
    parser.add_argument("--min_pixels", type=float, default=100*28*28)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--top_p", type=float, default=1.0)
    parser.add_argument("--top_k", type=int, default=-1)
    parser.add_argument("--history_n", type=int, default=5)
    parser.add_argument("--max_tokens", type=int, default=500)
    parser.add_argument("--stop_token", type=str, default=None)

    parser.add_argument("--max_trajectory_length", type=int, default=None, help="The max number of trajectory steps.")
    parser.add_argument("--max_image_history_length", type=int, default=5, help="The max number of images in the history.")

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument(
        "--test_all_meta_path", type=str, default="evaluation_examples/test_all.json"
    )

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results")
    parser.add_argument("--num_envs", type=int, default=1, help="Number of environments to run in parallel")  
    parser.add_argument("--log_level", type=str, choices=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], 
                       default='INFO', help="Set the logging level")
    # aws config
    parser.add_argument(
        "--region", type=str, default="us-east-1", help="AWS region for the VM"
    )
    parser.add_argument(
        "--provider_name", type=str, default="aws", choices=["aws", "virtualbox", "vmware", "docker", "azure"], help="Provider name"
    )
    parser.add_argument(
        "--client_password", type=str, default="password", help="Client password"
    )
    parser.add_argument(
        "--screen_width", type=int, default=1920, help="Screen width"
    )
    parser.add_argument(
        "--screen_height", type=int, default=1080, help="Screen height"
    )
    
    # Dart specific parameters
    parser.add_argument("--dart_api_key", type=str, default="", help="Dart API key")
    parser.add_argument("--dart_base_url", type=str, default="", help="Dart base URL")
    parser.add_argument("--max_images", type=int, default=5, help="Maximum number of images in prompt history")
    parser.add_argument("--max_texts", type=int, default=35, help="Maximum number of text responses in prompt history")
    
    # Enhanced trajectory saving
    parser.add_argument("--save_complete_trajectory", action="store_true", help="Save complete trajectory with images and detailed information")
    parser.add_argument("--use_enhanced_runner", action="store_true", help="Use enhanced Dart runner with complete trajectory saving")
    
    args = parser.parse_args()
    return args

args = config()  # Get command line arguments first

logger = logging.getLogger()
log_level = getattr(logging, args.log_level.upper())
logger.setLevel(log_level)

datetime_str: str = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")

file_handler = logging.FileHandler(
    os.path.join("logs", "dart-{:}.log".format(datetime_str)), encoding="utf-8"
)
debug_handler = logging.FileHandler(
    os.path.join("logs", "dart-debug-{:}.log".format(datetime_str)), encoding="utf-8"
)
stdout_handler = logging.StreamHandler(sys.stdout)

file_handler.setLevel(logging.INFO)
debug_handler.setLevel(logging.DEBUG)
stdout_handler.setLevel(log_level)

formatter = logging.Formatter(
    fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
)
file_handler.setFormatter(formatter)
debug_handler.setFormatter(formatter)
stdout_handler.setFormatter(formatter)

stdout_handler.addFilter(logging.Filter("desktopenv"))

logger.addHandler(file_handler)
logger.addHandler(debug_handler)
logger.addHandler(stdout_handler)
#  }}} Logger Configs #

logger = logging.getLogger("desktopenv.experiment")


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

def save_complete_trajectory_with_images(example_result_dir: str, task_info: dict, reward: float, 
                                       messages: list, all_images: list = None):
    """
    保存完整的轨迹信息，包括图片路径
    
    Args:
        example_result_dir: 结果保存目录
        task_info: 任务信息
        reward: 最终奖励分数
        messages: 完整的对话消息
        all_images: 所有图片数据列表（可选）
    """
    import datetime
    
    # 构建完整轨迹数据
    complete_trajectory = {
        "task_info": {
            "domain": task_info.get("domain", "unknown"),
            "example_id": task_info.get("example_id", "unknown"),
            "instruction": task_info.get("instruction", ""),
            "timestamp": datetime.datetime.now().isoformat()
        },
        "evaluation": {
            "reward": reward,
            "success": reward > 0
        },
        "trajectory": {
            "messages": [],
            "image_paths": [],
            "step_count": 0
        }
    }
    
    # 处理消息和图片路径
    image_counter = 0
    step_counter = 0
    
    for msg_idx, message in enumerate(messages):
        processed_message = {
            "step": step_counter,
            "role": message.get("role", "unknown"),
            "content": message.get("content", []),
            "timestamp": message.get("timestamp", ""),
            "image_files": []
        }
        
        # 检查消息中的图片内容
        if isinstance(message.get("content"), list):
            for content_item in message["content"]:
                if content_item.get("type") == "image_url":
                    # 如果有对应的图片数据，保存图片文件
                    if all_images and image_counter < len(all_images):
                        image_filename = f"step_{step_counter}_image_{image_counter}.png"
                        image_path = os.path.join(example_result_dir, image_filename)
                        
                        try:
                            # 保存图片
                            if hasattr(all_images[image_counter], 'save'):
                                # PIL Image对象
                                all_images[image_counter].save(image_path)
                            elif isinstance(all_images[image_counter], bytes):
                                # 二进制数据
                                with open(image_path, 'wb') as f:
                                    f.write(all_images[image_counter])
                            else:
                                logger.warning(f"Unknown image format for image {image_counter}")
                                continue
                            
                            processed_message["image_files"].append(image_filename)
                            complete_trajectory["trajectory"]["image_paths"].append(image_path)
                            logger.info(f"Saved image: {image_filename}")
                            
                        except Exception as e:
                            logger.error(f"Failed to save image {image_counter}: {e}")
                        
                        image_counter += 1
                    
                    # 更新content中的图片引用为本地路径
                    if processed_message["image_files"]:
                        content_item["local_path"] = processed_message["image_files"][-1]
        
        complete_trajectory["trajectory"]["messages"].append(processed_message)
        
        # 如果是assistant的回复，增加步数
        if message.get("role") == "assistant":
            step_counter += 1
    
    complete_trajectory["trajectory"]["step_count"] = step_counter
    
    # 保存完整轨迹JSON文件
    trajectory_file = os.path.join(example_result_dir, "complete_trajectory.json")
    try:
        with open(trajectory_file, 'w', encoding='utf-8') as f:
            json.dump(complete_trajectory, f, indent=2, ensure_ascii=False)
        logger.info(f"Complete trajectory saved to: {trajectory_file}")
        
        # 同时保存一个简化版本用于快速查看
        summary_file = os.path.join(example_result_dir, "trajectory_summary.json")
        summary = {
            "task_id": task_info.get("example_id", "unknown"),
            "domain": task_info.get("domain", "unknown"),
            "instruction": task_info.get("instruction", ""),
            "reward": reward,
            "success": reward > 0,
            "total_steps": step_counter,
            "total_images": len(complete_trajectory["trajectory"]["image_paths"]),
            "image_files": [os.path.basename(path) for path in complete_trajectory["trajectory"]["image_paths"]],
            "timestamp": complete_trajectory["task_info"]["timestamp"]
        }
        
        with open(summary_file, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2, ensure_ascii=False)
        logger.info(f"Trajectory summary saved to: {summary_file}")
        
    except Exception as e:
        logger.error(f"Failed to save complete trajectory: {e}")


def run_env_tasks(task_queue: Queue, args: argparse.Namespace, shared_scores: list):
    active_environments = []
    env = None
    try:
        # Initialize proxy configuration if enabled
        # if hasattr(args, 'proxy_host') and args.proxy_host and args.proxy_port:
        #     from desktop_env.providers.aws.proxy_pool import get_global_proxy_pool
        #     proxy_pool = get_global_proxy_pool()
        #     proxy_pool.add_proxy(
        #         host=args.proxy_host,
        #         port=args.proxy_port,
        #         protocol=args.proxy_protocol
        #     )
        #     logger.info(f"Added proxy: {args.proxy_host}:{args.proxy_port} ({args.proxy_protocol})")
        # elif hasattr(args, 'proxy_config') and args.proxy_config and os.path.exists(args.proxy_config):
        #     from desktop_env.providers.aws.proxy_pool import init_proxy_pool
        #     init_proxy_pool(args.proxy_config)
        #     logger.info(f"Initialized proxy pool from {args.proxy_config}")
        
        # Configure environment based on provider
        if args.provider_name == "aws":
            from desktop_env.providers.aws.manager import IMAGE_ID_MAP
            REGION = args.region
            screen_size = (args.screen_width, args.screen_height)
            ami_id = IMAGE_ID_MAP[REGION].get(screen_size, IMAGE_ID_MAP[REGION][(1920, 1080)])
            env = DesktopEnv(
                path_to_vm=args.path_to_vm,
                action_space=args.action_space,
                provider_name=args.provider_name,
                region=REGION,
                snapshot_name=ami_id,
                screen_size=screen_size,
                headless=args.headless,
                os_type="Ubuntu",
                require_a11y_tree=args.observation_type in ["a11y_tree", "screenshot_a11y_tree", "som"]
            )
        else:
            # For non-AWS providers (docker, virtualbox, etc.)
            env = DesktopEnv(
                path_to_vm=args.path_to_vm,
                action_space=args.action_space,
                provider_name=args.provider_name,
                headless=args.headless,
                os_type="Ubuntu",
                require_a11y_tree=args.observation_type in ["a11y_tree", "screenshot_a11y_tree", "som"]
            )
        active_environments.append(env)
        args.max_trajectory_length = args.max_steps
        
        # Dart specific runtime configuration
        if args.infer_mode == "dart_mode":
            runtime_conf: dict = {
                "infer_mode": args.infer_mode,
                "prompt_style": args.prompt_style,
                "input_swap": args.input_swap,
                "language": args.language,
                "history_n": args.history_n,
                "max_pixels": args.max_pixels,
                "min_pixels": args.min_pixels,
                "temperature": args.temperature,
                "top_k": args.top_k,
                "top_p": args.top_p,
                "max_tokens": args.max_tokens,
                "max_images": args.max_images,
                "max_texts": args.max_texts,
                "dart_api_key": args.dart_api_key,
                "dart_base_url": args.dart_base_url
            }
        elif args.infer_mode == "qwen2vl_user":
            runtime_conf: dict = {
                "infer_mode": "qwen2vl_user",
                "prompt_style": "qwen2vl_user",
                "input_swap": args.input_swap,
                "language": args.language,
                "history_n": 5,
                "max_pixels": 2116800,
                "min_pixels": 3136,
                "temperature": 0.0,
                "top_k": -1,
                "top_p": 0.9,
                "max_tokens": 1000
            }
        else:
            raise ValueError(f"Unknown infer_mode: {args.infer_mode}")
        
        agent = DartAgent(
            model=args.model,
            action_space=args.action_space,
            observation_type=args.observation_type,
            max_trajectory_length=args.max_trajectory_length,
            model_type=args.model_type,
            runtime_conf=runtime_conf
        )

        logger.info(f"Process {current_process().name} started with Dart configuration.")
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
                logger.info(f"[{current_process().name}][Domain]: {domain}")
                logger.info(f"[{current_process().name}][Example ID]: {example_id}")
                logger.info(f"[{current_process().name}][Instruction]: {example['instruction']}")
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
                    # Create a temporary list to capture the score
                    temp_scores = []
                    
                    # 根据参数选择使用哪个运行函数
                    if args.use_enhanced_runner or args.save_complete_trajectory:
                        # 使用九章专用的运行函数，支持完整轨迹保存
                        logger.info(f"Using enhanced Dart runner for {domain}/{example_id}")
                        lib_run_single.run_single_example(
                            agent,
                            env,
                            example,
                            args.max_steps,
                            example["instruction"],
                            args,
                            example_result_dir,
                            temp_scores,
                        )
                    else:
                        # 使用标准运行函数
                        lib_run_single.run_single_example(
                            agent,
                            env,
                            example,
                            args.max_steps,
                            example["instruction"],
                            args,
                            example_result_dir,
                            temp_scores,
                        )
                    # Add domain info to the score
                    if temp_scores:
                        shared_scores.append({
                            'domain': domain,
                            'example_id': example_id,
                            'score': temp_scores[-1]
                        })
                except Exception as e:
                    import traceback
                    logger.error(f"Exception in {current_process().name} {domain}/{example_id}: {e}")
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
                logger.error(f"Task-level error in {current_process().name}: {e}")
                import traceback
                logger.error(traceback.format_exc())
    except Exception as e:
        logger.error(f"Process-level error in {current_process().name}: {e}")
        import traceback
        logger.error(traceback.format_exc())
    finally:
        logger.info(f"{current_process().name} cleaning up environment...")
        try:
            if env:
                env.close()
                logger.info(f"{current_process().name} environment closed successfully")
        except Exception as e:
            logger.error(f"{current_process().name} error during environment cleanup: {e}")



def signal_handler(signum, frame):
    """Handle termination signals (SIGINT, SIGTERM) to gracefully shutdown environments."""
    global is_terminating, active_environments, processes
    
    # Avoid duplicate handling
    if is_terminating:
        return
    
    is_terminating = True
    logger.info(f"Received signal {signum}. Gracefully shutting down...")
    
    # Close all registered environments in the main process
    for env in active_environments:
        try:
            logger.info(f"Closing environment...")
            env.close()
            logger.info(f"Environment closed successfully")
        except Exception as e:
            logger.error(f"Error closing environment: {e}")
    
    # Send termination signal to all child processes first
    for p in processes:
        if p.is_alive():
            try:
                logger.info(f"Sending termination signal to process {p.name}...")
                p.terminate()
            except Exception as e:
                logger.error(f"Error sending termination signal to process: {e}")
    
    # Allow a short time for processes to handle their own cleanup
    time.sleep(1)
    
    # Forcefully terminate any processes that didn't exit
    for p in processes:
        if p.is_alive():
            try:
                logger.info(f"Forcefully terminating process {p.name}...")
                import signal as sig
                os.kill(p.pid, sig.SIGKILL)
            except Exception as e:
                logger.error(f"Error forcefully terminating process: {e}")
    
    logger.info("Shutdown complete. Exiting.")
    sys.exit(0)


def test(args: argparse.Namespace, test_all_meta: dict) -> None:
    global processes
    logger.info("Args: %s", args)
    all_tasks = distribute_tasks(test_all_meta)
    logger.info(f"Total tasks: {len(all_tasks)}")
    with Manager() as manager:
        shared_scores = manager.list()
        task_queue = manager.Queue()
        for item in all_tasks:
            task_queue.put(item)
        num_envs = args.num_envs
        processes = []
        for i in range(num_envs):
            p = Process(
                target=run_env_tasks,
                args=(task_queue, args, shared_scores),
                name=f"DartEnvProcess-{i+1}"
            )
            p.daemon = True
            p.start()
            processes.append(p)
            logger.info(f"Started Dart process {p.name} with PID {p.pid}")
        try:
            while True:
                alive_count = 0
                for idx, p in enumerate(processes):
                    if not p.is_alive():
                        logger.warning(f"Process {p.name} died, restarting...")
                        new_p = Process(
                            target=run_env_tasks,
                            args=(task_queue, args, shared_scores),
                            name=f"DartEnvProcess-Restart-{idx+1}"
                        )
                        new_p.daemon = True
                        new_p.start()
                        processes[idx] = new_p
                        logger.info(f"Restarted process {new_p.name} with PID {new_p.pid}")
                    else:
                        alive_count += 1
                if task_queue.empty():
                    logger.info("All tasks finished.")
                    break
                if alive_count == 0:
                    logger.error("All processes died, exiting.")
                    break
                time.sleep(5)
            for p in processes:
                p.join()
        except KeyboardInterrupt:
            logger.info("Main process received KeyboardInterrupt. Initiating graceful shutdown...")
            raise
        except Exception as e:
            logger.error(f"Unexpected error while waiting for processes: {e}", exc_info=True)
            for p in processes:
                if p.is_alive():
                    try:
                        logger.info(f"Terminating process {p.name} due to error...")
                        p.terminate()
                    except Exception as term_e:
                        logger.error(f"Error terminating process {p.name}: {term_e}")
            raise
        scores = list(shared_scores)
    
    # Detailed statistics reporting
    if scores:
        # Extract numeric scores for overall statistics
        numeric_scores = []
        domain_stats = {}
        
        for score_entry in scores:
            if isinstance(score_entry, dict):
                domain = score_entry.get('domain', 'unknown')
                example_id = score_entry.get('example_id', 'unknown')
                score = score_entry.get('score', 0)
            else:
                # Handle legacy numeric scores
                domain = 'unknown'
                example_id = 'unknown'
                score = score_entry
            
            numeric_scores.append(score)
            
            # Domain statistics
            if domain not in domain_stats:
                domain_stats[domain] = {'total': 0, 'success': 0, 'scores': []}
            
            domain_stats[domain]['total'] += 1
            domain_stats[domain]['scores'].append(score)
            if score > 0:
                domain_stats[domain]['success'] += 1
        
        # Overall statistics
        total_tasks = len(numeric_scores)
        successful_tasks = sum(1 for score in numeric_scores if score > 0)
        average_score = sum(numeric_scores) / total_tasks
        success_rate = (successful_tasks / total_tasks) * 100
        
        logger.info("=" * 60)
        logger.info("📊 DART EVALUATION RESULTS SUMMARY")
        logger.info("=" * 60)
        logger.info(f"📈 Overall Statistics:")
        logger.info(f"   • Total tasks executed: {total_tasks}")
        logger.info(f"   • Successful tasks (score > 0): {successful_tasks}")
        logger.info(f"   • Success rate: {success_rate:.1f}%")
        logger.info(f"   • Average score: {average_score:.3f}")
        
        # Domain-specific statistics
        if domain_stats and len(domain_stats) > 1:  # Only show domain breakdown if multiple domains
            logger.info(f"\n🏷️  Domain-specific Results:")
            for domain, stats in sorted(domain_stats.items()):
                domain_success_rate = (stats['success'] / stats['total']) * 100 if stats['total'] > 0 else 0
                domain_avg_score = sum(stats['scores']) / len(stats['scores']) if stats['scores'] else 0
                logger.info(f"   • {domain}:")
                logger.info(f"     - Tasks: {stats['total']}")
                logger.info(f"     - Successful: {stats['success']}")
                logger.info(f"     - Success rate: {domain_success_rate:.1f}%")
                logger.info(f"     - Average score: {domain_avg_score:.3f}")
        
        # Score distribution
        score_ranges = {
            'Perfect (1.0)': sum(1 for s in numeric_scores if s == 1.0),
            'High (0.8-0.99)': sum(1 for s in numeric_scores if 0.8 <= s < 1.0),
            'Medium (0.5-0.79)': sum(1 for s in numeric_scores if 0.5 <= s < 0.8),
            'Low (0.1-0.49)': sum(1 for s in numeric_scores if 0.1 <= s < 0.5),
            'Failed (0.0)': sum(1 for s in numeric_scores if s == 0.0)
        }
        
        logger.info(f"\n📊 Score Distribution:")
        for range_name, count in score_ranges.items():
            if count > 0:
                percentage = (count / total_tasks) * 100
                logger.info(f"   • {range_name}: {count} tasks ({percentage:.1f}%)")
        
        logger.info("=" * 60)
    else:
        logger.warning("⚠️  No scores collected during evaluation!")


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


def clear_cache_directory():
    """清空cache目录中的所有内容"""
    cache_dir = "cache"
    if os.path.exists(cache_dir):
        logger.info(f"Clearing cache directory: {cache_dir}")
        try:
            import shutil
            # 删除整个cache目录
            shutil.rmtree(cache_dir)
            # 重新创建空的cache目录
            os.makedirs(cache_dir, exist_ok=True)
            logger.info("Cache directory cleared successfully")
        except Exception as e:
            logger.error(f"Failed to clear cache directory: {e}")
    else:
        logger.info("Cache directory does not exist, creating it")
        os.makedirs(cache_dir, exist_ok=True)


def cleanup_docker_containers():
    """清理Docker容器，保留monitor容器"""
    logger.info("Cleaning up Docker containers...")
    try:
        import subprocess
        
        # 获取所有容器ID，排除monitor-monitor-1
        cmd = 'docker ps --format "{{.ID}} {{.Names}}" | grep -v "monitor-monitor-1" | awk \'{print $1}\''
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0 and result.stdout.strip():
            container_ids = result.stdout.strip().split('\n')
            container_ids = [cid for cid in container_ids if cid.strip()]
            
            if container_ids:
                logger.info(f"Found {len(container_ids)} containers to remove: {container_ids}")
                
                # 强制删除容器
                for container_id in container_ids:
                    try:
                        rm_result = subprocess.run(
                            f"docker rm -f {container_id}",
                            shell=True,
                            capture_output=True,
                            text=True,
                            timeout=10
                        )
                        if rm_result.returncode == 0:
                            logger.info(f"Successfully removed container: {container_id}")
                        else:
                            logger.warning(f"Failed to remove container {container_id}: {rm_result.stderr}")
                    except subprocess.TimeoutExpired:
                        logger.warning(f"Timeout removing container: {container_id}")
                    except Exception as e:
                        logger.error(f"Error removing container {container_id}: {e}")
                
                logger.info("Docker container cleanup completed")
            else:
                logger.info("No containers found to remove")
        else:
            logger.info("No containers found or error getting container list")
            
    except subprocess.TimeoutExpired:
        logger.error("Timeout during Docker container cleanup")
    except Exception as e:
        logger.error(f"Failed to cleanup Docker containers: {e}")


if __name__ == "__main__":
    ####### Dart Version - Complete evaluation runner #######
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    
    # Register signal handlers for graceful termination
    signal.signal(signal.SIGINT, signal_handler)  # Handle Ctrl+C
    signal.signal(signal.SIGTERM, signal_handler)  # Handle termination signal
    
    try:
        args = config()
        
        # 清理Docker容器
        # 清除上一次存留的docker 容器 自己跑的时候要留着
        cleanup_docker_containers()
        
        # 清空cache目录 清除上一次下载的文件
        clear_cache_directory()
        
        logger.info("Starting Dart evaluation runner...")
        
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
        test(args, test_file_list)
    except KeyboardInterrupt:
        logger.info("Main process received KeyboardInterrupt.")
        # Signal handler will take care of cleanup
    except Exception as e:
        logger.error(f"Unexpected error in main process: {e}", exc_info=True)
        # Also trigger cleanup for unhandled exceptions
        signal_handler(signal.SIGTERM, None)
    finally:
        # Final cleanup in case any environments or processes remain
        logger.info("Main process final cleanup...")
        for env in active_environments:
            if env is not None:
                try:
                    logger.info(f"Closing environment in final cleanup...")
                    env.close()
                    logger.info(f"Environment closed successfully in final cleanup")
                except Exception as e:
                    logger.error(f"Error during final environment cleanup: {e}")
        
        # First try gentle termination
        for p in processes:
            if p is not None and p.is_alive():
                try:
                    logger.info(f"Terminating process {p.name}...")
                    p.terminate()
                except Exception as e:
                    logger.error(f"Error terminating process: {e}")
        
        # Wait a moment for processes to terminate
        time.sleep(1)
        
        # Then force kill if needed
        for p in processes:
            if p is not None and p.is_alive():
                try:
                    logger.info(f"Force killing process {p.name}...")
                    os.kill(p.pid, signal.SIGKILL)
                    logger.info(f"Process {p.name} force killed")
                except Exception as e:
                    logger.error(f"Error force killing process: {e}")