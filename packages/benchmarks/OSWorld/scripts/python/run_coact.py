import argparse
import base64
import glob
import datetime
import shutil
import traceback
from typing import Dict, List
import json
import time
import os
from mm_agents.coact.operator_agent import OrchestratorAgent, OrchestratorUserProxyAgent
from mm_agents.coact.autogen import LLMConfig
import logging
from multiprocessing import Pool, cpu_count
from functools import partial
import sys

# Add project root to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))



TASK_DESCRIPTION = """# Your role
You are a task solver, you need to complete a computer-using task step-by-step.
1. Describe the screenshot.
2. Provide a detailed plan, including a list of user requirements like specific file name, file path, etc.
3. Follow the following instructions and complete the task with your skills.
    - If you think the task is impossible to complete (no file, wrong environment, etc.), reply with "INFEASIBLE" to end the conversation.
    - **Do not** do (or let coding/GUI agent do) anything else out of the user's instruction like change the file name. This will make the task fail.
    - Check every screenshot carefully and see if it fulfills the task requirement.
    - You MUST try the Coding Agent first for file operation tasks like spreadsheet modification.
4. Verify the result and see if it fulfills the user's requirement.

# Your helpers
You can use the following tools to solve the task. You can only call one of gui agent or coding agent per reply:

## Programmer
Let a programmer to solve a subtask you assigned. 
The Programmer can write python or bash code to modify almost everything in the computer, like files, apps, system settings, etc. 
It requires a environment description and a detailed task description. As detailed as possible.
Can use any python package you instructed.
Will return a summary with the output of the code.
When letting coding agent to modify the spreadsheet, after the task completed, you MUST make sure EVERY modified value in the spreadsheet is in the desired position (e.g., filled in the expected cell) by a GUI Operator.
After that, if anything is wrong, tell the programmer to modify it.

## GUI Operator
Let a GUI agent to solve a subtask you assigned. 
GUI agent can operate the computer by clicking and typing (but not accurate). 
Require a detailed task description.
When you call GUI agent, it will only have a **20-step** budget to complete your task. Each step is a one-time interaction with OS like mouse click or keyboard typing. Please take this into account when you plan the actions.
If you let GUI Operator to check the result, you MUST let it close and reopen the file because programmer's result will NOT be updated to the screen. 
"""


def config() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run end-to-end evaluation on the benchmark"
    )

    # environment config
    parser.add_argument("--path_to_vm", type=str, default=None)
    parser.add_argument("--provider_name", type=str, default="aws")
    parser.add_argument("--screen_width", type=int, default=1920)
    parser.add_argument("--screen_height", type=int, default=1080)
    parser.add_argument("--sleep_after_execution", type=float, default=0.5)
    parser.add_argument("--region", type=str, default="us-east-1")
    parser.add_argument("--client_password", type=str, default="osworld-public-evaluation")

    # agent config
    parser.add_argument("--oai_config_path", type=str, default="/home/ubuntu/OSWorld/mm_agents/coact/OAI_CONFIG_LIST")
    parser.add_argument("--orchestrator_model", type=str, default="o3")
    parser.add_argument("--coding_model", type=str, default="o4-mini")
    parser.add_argument("--cua_model", type=str, default="computer-use-preview")
    parser.add_argument("--orchestrator_max_steps", type=int, default=15)
    parser.add_argument("--coding_max_steps", type=int, default=20)
    parser.add_argument("--cua_max_steps", type=int, default=25)
    parser.add_argument("--cut_off_steps", type=int, default=200)

    # example config
    parser.add_argument("--domain", type=str, default="all")
    parser.add_argument(
        "--test_all_meta_path", type=str, default="evaluation_examples/test_all.json"
    )
    parser.add_argument(
        "--test_config_base_dir", type=str, default="evaluation_examples/examples"
    )

    # logging related
    parser.add_argument("--result_dir", type=str, default="./results_coact")
    parser.add_argument("--num_envs", type=int, default=1, help="Number of environments to run in parallel")
    parser.add_argument("--log_level", type=str, choices=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], 
                       default='INFO', help="Set the logging level")

    args = parser.parse_args()
    return args

args = config()

logger = logging.getLogger()

log_level = getattr(logging, args.log_level.upper())
logger.setLevel(log_level)

datetime_str: str = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")

file_handler = logging.FileHandler(
    os.path.join("logs", "normal-{:}.log".format(datetime_str)), encoding="utf-8"
)
debug_handler = logging.FileHandler(
    os.path.join("logs", "debug-{:}.log".format(datetime_str)), encoding="utf-8"
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

logger = logging.getLogger("desktopenv.expeiment")


def process_task(task_info, 
                provider_name,
                path_to_vm,
                orchestrator_model="o3",
                coding_model='o4-mini',
                save_dir='results',
                orchestrator_max_steps=15,
                cua_max_steps=25,
                coding_max_steps=20,
                cut_off_steps=150,
                screen_width=1920,
                screen_height=1080,
                sleep_after_execution=0.5,
                config_path="OAI_CONFIG_LIST",
                region="us-east-1",
                client_password="",
                ):
    """Worker function to process a single task"""
    domain, ex_id, cfg = task_info
    
    # Recreate llm_config inside the worker process
    llm_config = LLMConfig.from_json(path=config_path).where(model=orchestrator_model)
    
    history_save_dir = os.path.join(save_dir, "coact", f"{domain}/{ex_id}")
    if not os.path.exists(history_save_dir):
        os.makedirs(history_save_dir)
    
    task_config = json.load(open(cfg))
    retry = 0

    while True:
        try:
            with llm_config:
                orchestrator = OrchestratorAgent(
                    name="orchestrator",
                    system_message=TASK_DESCRIPTION
                )
                orchestrator_proxy = OrchestratorUserProxyAgent(
                    name="orchestrator_proxy",
                    is_termination_msg=lambda x: x.get("content", "") and (x.get("content", "")[0]["text"].lower() == "terminate" or x.get("content", "")[0]["text"].lower() == "infeasible"),
                    human_input_mode="NEVER",
                    provider_name=provider_name,
                    path_to_vm=path_to_vm,
                    screen_width=screen_width,
                    screen_height=screen_height,
                    sleep_after_execution=sleep_after_execution,
                    code_execution_config=False,
                    history_save_dir=history_save_dir,
                    llm_model=coding_model,
                    truncate_history_inputs=cua_max_steps + 1,
                    cua_max_steps=cua_max_steps,
                    coding_max_steps=coding_max_steps,
                    region=region,
                    client_password=client_password,
                    user_instruction=task_config["instruction"]
                )

            orchestrator_proxy.reset(task_config=task_config)
            time.sleep(60)
            screenshot = orchestrator_proxy.env.controller.get_screenshot()

            with open(os.path.join(history_save_dir, f'initial_screenshot_orchestrator.png'), "wb") as f:
                f.write(screenshot)
                
            orchestrator_proxy.initiate_chat(
                recipient=orchestrator,
                message=f"""{task_config["instruction"]}
Check my computer screenshot and describe it first. If this task is possible to complete, please complete it on my computer. If not, reply with "INFEASIBLE" to end the conversation.
I will not provide further information to you.""" + "<img data:image/png;base64," + base64.b64encode(screenshot).decode("utf-8") + ">",
                max_turns=orchestrator_max_steps
            )
            
            chat_history = []
            key = list(orchestrator_proxy.chat_messages.keys())[0]
            chat_messages = orchestrator_proxy.chat_messages[key]
            for item in chat_messages:
                item.pop('tool_responses', None)
                if item.get('role', None) in ['tool', 'assistant'] and item.get('content', None):
                    for msg in item['content']:
                        if msg.get('type', None) == 'image_url':
                            msg['image_url'] = "<image>"
                chat_history.append(item)
            
            with open(os.path.join(history_save_dir, f'chat_history.json'), "w") as f:
                json.dump(chat_history, f)

            if chat_history[-1]['role'] == 'user' and 'INFEASIBLE' in chat_history[-1]['content'][0]['text']:
                orchestrator_proxy.env.action_history.append("FAIL")

            cua_steps = len(glob.glob(f"{history_save_dir}/cua_output*/step_*.png"))
            coding_paths = glob.glob(f"{history_save_dir}/coding_output*/chat_history.json")
            coding_steps = 0
            for hist in coding_paths:
                with open(hist, 'r') as f:
                    hist = json.dumps(json.load(f))
                    coding_steps += hist.count('exitcode:')
            if cua_steps + coding_steps > cut_off_steps:
                score = 0.0
            else:
                score = orchestrator_proxy.env.evaluate()
            print(f"Score: {score}")
            
            with open(os.path.join(history_save_dir, f'result.txt'), "w") as f:
                f.write(str(score))
            break
                    
        except Exception as e:
            retry += 1
            if retry < 3:
                shutil.rmtree(history_save_dir)
                os.makedirs(history_save_dir)
                print(f"Retry {retry} times, error: {str(e)}")
                traceback.print_exc()
                continue

            print(f"Error processing task {domain}/{ex_id}")
            traceback.print_exc()
            score = 0.0
            with open(os.path.join(history_save_dir, f'result.txt'), "w") as f:
                f.write(str(score))
            with open(os.path.join(history_save_dir, f'err_reason.txt'), "w") as f:
                f.write(f"Fatal error: {str(e)}")
        finally:
            if orchestrator_proxy.env is not None:
                orchestrator_proxy.env.close()
    
    return domain, score


if __name__ == "__main__":
    args = config()

    with open(args.test_all_meta_path, encoding="utf-8") as f:
        test_all_meta = json.load(f)
    if args.domain != "all":
        test_all_meta = {args.domain: test_all_meta[args.domain]}

    tasks = []
    scores: Dict[str, List[float]] = {}
    for domain in test_all_meta:
        scores[domain] = []
        for ex_id in test_all_meta[domain]:
            if os.path.exists(os.path.join(args.result_dir, 'coact', f"{domain}/{ex_id}/result.txt")):
                result = open(os.path.join(args.result_dir, 'coact', f"{domain}/{ex_id}/result.txt"), "r").read()
                print(f"Results already exist in {domain}/{ex_id}, result: {result}")
                continue
            cfg = os.path.join(args.test_config_base_dir, f"{domain}/{ex_id}.json")
            tasks.append((domain, ex_id, cfg))
    # Check if there are any tasks to process
    if not tasks:
        print("No tasks to process. All tasks have already been completed.")
        # Print summary of existing results
        print("\n=== Summary of Existing Results ===")
        for domain in test_all_meta:
            domain_scores = []
            for ex_id in test_all_meta[domain]:
                score_file = os.path.join(args.result_dir, 'coact', f"{domain}/{ex_id}/result.txt")
                if os.path.exists(score_file):
                    with open(score_file, "r") as f:
                        domain_scores.append(float(f.read()))
            if domain_scores:
                avg_score = sum(domain_scores) / len(domain_scores)
                print(f"{domain}: {len(domain_scores)} tasks, average score: {avg_score:.2f}")
    else:
        # Use multiprocessing to process tasks in parallel
        # Determine number of workers (you can adjust this based on your system)
        num_workers = min(cpu_count() // 2, args.num_envs)  # Use half of CPU cores, max 4
        print(f"Processing {len(tasks)} tasks with {num_workers} workers...")

        # Create a partial function with fixed config_path, model and debug
        process_func = partial(process_task, 
                               provider_name=args.provider_name,
                               path_to_vm=args.path_to_vm,
                               save_dir=args.result_dir,
                               coding_model=args.coding_model,
                               orchestrator_model=args.orchestrator_model,
                               config_path=args.oai_config_path, 
                               orchestrator_max_steps=args.orchestrator_max_steps,
                               cua_max_steps=args.cua_max_steps,
                               coding_max_steps=args.coding_max_steps,
                               cut_off_steps=args.cut_off_steps,
                               screen_width=args.screen_width,
                               screen_height=args.screen_height,
                               sleep_after_execution=args.sleep_after_execution,
                               region=args.region,
                               client_password=args.client_password
                               )

        # Process tasks in parallel
        with Pool(processes=num_workers) as pool:
            results = pool.map(process_func, tasks)

        # Collect scores from results
        for domain, score in results:
            scores[domain].append(score)

        # Print summary
        print("\n=== Task Processing Complete ===")
        for domain in scores:
            if scores[domain]:
                avg_score = sum(scores[domain]) / len(scores[domain])
                print(f"{domain}: {len(scores[domain])} tasks, average score: {avg_score:.2f}")
