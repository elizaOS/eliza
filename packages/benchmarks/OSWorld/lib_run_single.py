import datetime
import json
import logging
import os
import time
from wrapt_timeout_decorator import *
from lib_results_logger import log_task_completion

logger = logging.getLogger("desktopenv.experiment")


def run_single_example(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)

    # Reset environment first to get fresh VM IP
    env.reset(task_config=example)

    # Reset agent with fresh VM IP (for snapshot reverts)
    try:
        agent.reset(runtime_logger, vm_ip=env.vm_ip)
    except Exception as e:
        agent.reset(vm_ip=env.vm_ip)
    
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs
        )
        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S%f")
            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info = env.step(action, args.sleep_after_execution)

            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action_timestamp": action_timestamp,
                    "action": action,
                    "response": response,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1
    time.sleep(20) # Wait for the environment to settle
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    
    # Log task completion to results.json
    log_task_completion(example, result, example_result_dir, args)
    
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))


def setup_logger(example, example_result_dir):
    runtime_logger = logging.getLogger(f"desktopenv.example.{example['id']}")
    runtime_logger.setLevel(logging.DEBUG)
    runtime_logger.addHandler(logging.FileHandler(os.path.join(example_result_dir, "runtime.log")))
    return runtime_logger

def run_single_example_human(env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    
    # Save initial screenshot
    with open(os.path.join(example_result_dir, "initial_state.png"), "wb") as _f:
        _f.write(obs['screenshot'])
    
    # Save trajectory information
    with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
        f.write(json.dumps({
            "instruction": instruction,
            "initial_state": "initial_state.png"
        }))
        f.write("\n")
    
    # Evaluate the result
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")


def run_single_example_kimi(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    agent.reset(runtime_logger)
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions, info_dict = agent.predict(instruction, obs)

        logger.info(f"Got Action: {actions}")
        # Breack if no actions
        if not actions or len(actions)==0 or actions[0]=="" or actions[0].lower().startswith("error"): 
            break

        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            
            obs, reward, done, info = env.step(action, args.sleep_after_execution)

            logger.info(f"Action {action} executed, reward: {reward}, done: {done}")
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])

            with open(os.path.join(example_result_dir, "traj.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action": action,
                    "natural_language_action": info_dict.get("action"),
                    "action_timestamp": action_timestamp,
                    "response": response,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }, ensure_ascii=False))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1

    time.sleep(30) # Wait for the environment to settle
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))

def run_single_example_agi(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    agent.reset(runtime_logger)
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs
        )

        done = not response.get('state_correct', False)

        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info, step_info = agent.step(action)

            if not done:
                if not response.get('state_correct', False):
                    done = True

            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])

            # Remove pending checks if they exist which will cause issues with json serialization
            if action.get('pending_checks', None):
                del action['pending_checks']

            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action_timestamp": action_timestamp,
                    "action": action,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))


def run_single_example_openaicua(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    agent.reset(runtime_logger)
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs
        )

        done = not response.get('state_correct', False)

        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info, step_info = agent.step(action)

            if not done:
                if not response.get('state_correct', False):
                    done = True

            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])

            # Remove pending checks if they exist which will cause issues with json serialization
            if action.get('pending_checks', None):
                del action['pending_checks']

            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action_timestamp": action_timestamp,
                    "action": action,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))

def run_single_example_opencua(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    agent.reset(runtime_logger)
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions, info_dict = agent.predict(instruction, obs)

        logger.info(f"Got Action: {actions}")
        # Breack if no actions
        if not actions or len(actions)==0 or actions[0]=="" or actions[0].lower().startswith("error"): 
            break

        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            
            obs, reward, done, info = env.step(action, args.sleep_after_execution)

            logger.info(f"Action {action} executed, reward: {reward}, done: {done}")
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])

            with open(os.path.join(example_result_dir, "traj.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action": action,
                    "natural_language_action": info_dict.get("action"),
                    "action_timestamp": action_timestamp,
                    "response": response,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }, ensure_ascii=False))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1

    time.sleep(20) # Wait for the environment to settle
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))

def run_single_example_autoglm(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    try:
        agent.reset(runtime_logger)
    except Exception as e:
        agent.reset()

    env.reset(task_config=example)
    
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs
        )
        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info = env.step(action, args.sleep_after_execution)

            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action_timestamp": action_timestamp,
                    "action": action,
                    "response": response,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }))
                f.write("\n")
                
            if done:
                logger.info("The episode is done.")
                break
        
        # Invalid Action
        if not actions:
            obs = env._get_obs() # update observation
            
        step_idx += 1
    
    if not done: # not completed the task yet
        env.action_history.append('FAIL')
    
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))

def run_single_example_mano(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    agent.reset(runtime_logger)
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    
    with open(os.path.join(example_result_dir, f"step_0.png"),
      "wb") as _f:
        _f.write(obs['screenshot'])
    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs
        )
        if len(actions) > 1:
            if (("pyautogui.hotkey('shift')" in actions[0] or "pyautogui.hotkey('ctrl')" in actions[0]) 
                and "pyautogui.click" in actions[1]):
                hotkey_type = 'shift' if "shift" in actions[0] else 'ctrl'
                action = f"pyautogui.keyDown('{hotkey_type}')\n{actions[1]}\npyautogui.keyUp('{hotkey_type}')"
                actions = [action]  
                
        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info = env.step(action, args.sleep_after_execution)

            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action_timestamp": action_timestamp,
                    "action": action,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png",
                    "response":response
                }))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))
    
def run_single_example_uipath(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    runtime_logger = setup_logger(example, example_result_dir)
    try:
        agent.reset(runtime_logger)
    except Exception as e:
        agent.reset()

    env.reset(task_config=example)

    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs,
            args,
            step_idx
        )
        for action in actions:
            # Capture the timestamp before executing the action
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info = env.step(action, args.sleep_after_execution)

            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            # Save screenshot and trajectory information
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                      "wb") as _f:
                _f.write(obs['screenshot'])
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                f.write(json.dumps({
                    "step_num": step_idx + 1,
                    "action_timestamp": action_timestamp,
                    "action": action,
                    "response": response,
                    "reward": reward,
                    "done": done,
                    "info": info,
                    "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png"
                }))
                f.write("\n")
            if done:
                logger.info("The episode is done.")
                break
        step_idx += 1
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))


from mm_agents.os_symphony.utils.common_utils import draw_coordinates
from mm_agents.os_symphony.utils.process_context import set_current_result_dir


logger = logging.getLogger("desktopenv.experiment")

def run_single_example_os_symphony(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    set_current_result_dir(example_result_dir)
    
    agent.reset(result_dir=example_result_dir)
    env.reset(task_config=example)
    time.sleep(30) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0
    # env.controller.start_recording()
    start_time = time.time()

    while not done and step_idx < max_steps:
        response, actions = agent.predict(
            instruction,
            obs,
            step_idx == max_steps - 1
        )
        for action in actions:
            # Save screenshot and trajectory information
            if "reflection" in response and response["reflection"].get("is_milestone"):
                img_name = f"step_{step_idx + 1}_milestone.png"
            else:
                img_name = f"step_{step_idx + 1}.png"
                
            with open(os.path.join(example_result_dir, img_name),
                      "wb") as _f:
                _f.write(obs['screenshot'])
            if "coordinates" in response and response["coordinates"]:
                draw_coordinates(
                    image_bytes=obs['screenshot'], 
                    coordinates=response["coordinates"], 
                    save_path=os.path.join(example_result_dir, img_name[:-4] + "_draw.png")
                )

            logger.info("Step %d: %s", step_idx + 1, action)
            obs, reward, done, info = env.step(action, args.sleep_after_execution)
            logger.info("Done: %s", done)

            with open(os.path.join(example_result_dir, "traj.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "instruction": instruction,
                    "step_num": step_idx + 1,
                    "action": action,
                    "response": response,
                    "done": done,
                    "info": info,
                    "screenshot_file": img_name
                }))
                f.write("\n")
            with open(os.path.join(example_result_dir, f"traj_{step_idx+1}.json"), "w", encoding="utf-8") as f:
                json.dump({
                    "step_num": step_idx + 1,
                    "action": action,
                    "response": response,
                    "done": done,
                    "info": info,
                    "screenshot_file": img_name
                }, f, indent=4, ensure_ascii=False)
            if done:
                logger.info("The episode is done.")
                time.sleep(60)
                break
        step_idx += 1
    end_time = time.time()
    result = float(env.evaluate())
    logger.info("Result: %.2f", result)
    scores.append(result)
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")

    with open(os.path.join(example_result_dir, "time.txt"), "w", encoding="utf-8") as f:
        f.write(f"{end_time-start_time:.2f}\n")


def run_single_example_evocua(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    """
    Unified run function for EvoCUAAgent (supporting both S1 and S2 modes).
    """
    runtime_logger = setup_logger(example, example_result_dir)
    
    # Reset Environment
    env.reset(task_config=example)
    
    # Reset Agent
    # Handle agent reset signature differences if any
    try:
        agent.reset(runtime_logger, vm_ip=env.vm_ip)
    except Exception:
        try:
            agent.reset(runtime_logger)
        except Exception:
            agent.reset()

    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation
    done = False
    step_idx = 0

    env.controller.start_recording()
    while not done and step_idx < max_steps:
        # EvoCUAAgent.predict unified signature: returns (response, actions)
        # It handles both modes internally.
        predict_res = agent.predict(instruction, obs)
        
        # Check return signature logic
        if len(predict_res) == 3:
            # Compatibility with S1 original signature if agent was updated to match
            response, actions, info_dict = predict_res
        else:
            response, actions = predict_res
            info_dict = {}

        logger.info(f"Step {step_idx + 1} Actions: {actions}")
        
        # Break if no actions (fail-safe)
        if not actions or (len(actions) == 1 and (actions[0] == "" or "error" in actions[0].lower())):
             # Allow "FAIL" or "DONE" to process through execution loop if agent outputs them as actions
             if not (actions and actions[0] in ["FAIL", "DONE"]):
                 logger.warning("No valid actions returned. Breaking loop.")
                 break

        for action in actions:
            action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S%f")
            logger.info("Executing action: %s", action)
            
            # Execute
            obs, reward, done, info = env.step(action, args.sleep_after_execution)
            
            logger.info("Reward: %.2f", reward)
            logger.info("Done: %s", done)
            
            # Save screenshot
            screenshot_file = f"step_{step_idx + 1}_{action_timestamp}.png"
            with open(os.path.join(example_result_dir, screenshot_file), "wb") as _f:
                _f.write(obs['screenshot'])
            
            # Log Trajectory
            log_entry = {
                "step_num": step_idx + 1,
                "action_timestamp": action_timestamp,
                "action": action,
                "response": response,
                "reward": reward,
                "done": done,
                "info": info,
                "screenshot_file": screenshot_file
            }
            # Add natural language info if available (S1 style)
            if info_dict:
                log_entry["natural_language_action"] = info_dict.get("action")
            
            with open(os.path.join(example_result_dir, "traj.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(log_entry, ensure_ascii=False))
                f.write("\n")
                
            if done:
                logger.info("The episode is done.")
                break
        
        step_idx += 1
        
    time.sleep(20) # Wait for environment to settle
    result = env.evaluate()
    logger.info("Result: %.2f", result)
    scores.append(result)
    
    with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
        f.write(f"{result}\n")
    
    log_task_completion(example, result, example_result_dir, args)

    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))


def run_single_example_mobileagent_v3(agent, env, example, max_steps, instruction, args, example_result_dir, scores):
    """
    Specialized run function for MobileAgent V3.
    
    This agent has a different interface where it calls agent.step() directly
    which internally handles prediction and execution.
    """
    runtime_logger = setup_logger(example, example_result_dir)
    try:
        agent.reset(runtime_logger)
    except:
        agent.reset()
    env.reset(task_config=example)
    time.sleep(60) # Wait for the environment to be ready
    obs = env._get_obs() # Get the initial observation

    done = False
    step_idx = 0
    
    # save the first step
    action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")
    with open(os.path.join(example_result_dir, f"step_{step_idx}_{action_timestamp}.png"), "wb") as _f:
        _f.write(obs['screenshot'])
    
    eval_flag = True
    env.controller.start_recording()
    while not done and step_idx < max_steps:
        global_state, action_code, step_status, reward, done = agent.step(instruction, env, args)
        action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S")

        if step_status is False:
            eval_flag = False
            done = True
            reward = None
        else:
            obs = env._get_obs()
            with open(os.path.join(example_result_dir, f"step_{step_idx + 1}_{action_timestamp}.png"),
                        "wb") as _f:
                _f.write(obs['screenshot'])
        with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
            f.write(json.dumps({
                "step_num": step_idx + 1,
                "step_status": step_status,
                "action_timestamp": action_timestamp,
                "action": action_code,
                "reward": reward,
                "done": done,
                "screenshot_file": f"step_{step_idx + 1}_{action_timestamp}.png",
            }))
            f.write("\n")
        if done:    
            logger.info("The episode is done.")
            break
        step_idx += 1

    if eval_flag:
        result = env.evaluate()
        logger.info("Result: %.2f", result)
        scores.append(result)
        with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
            f.write(f"{result}\n")
    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))
