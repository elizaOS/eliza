#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from functools import cache
import os
import json
import time
from datetime import datetime
from flask import Flask, jsonify, send_file, request, render_template
from dotenv import load_dotenv


# Load environment variables from .env file
load_dotenv()

# {task_type}_{task_id}: (status_dict, timestamp)
# For "Done" status, we need to verify it for a period to ensure it doesn't change to "Error"
TASK_STATUS_CACHE = {}
# Time in seconds to consider "Done" status as stable (default: 30s)
DONE_STABILITY_PERIOD = int(os.getenv("DONE_STABILITY_PERIOD", "30"))

app = Flask(__name__)

MONITOR_IN_DOCKER = os.getenv("MONITOR_IN_DOCKER", "false").lower() == "true"

if MONITOR_IN_DOCKER:
    # If running in Docker, use default paths
    TASK_CONFIG_PATH = "/app/evaluation_examples/test.json"
    EXAMPLES_BASE_PATH = "/app/evaluation_examples/examples"
    RESULTS_BASE_PATH = "/app/results"
else:
    # Load configuration from environment variables
    TASK_CONFIG_PATH = os.getenv("TASK_CONFIG_PATH", "../evaluation_examples/test.json")
    EXAMPLES_BASE_PATH = os.getenv("EXAMPLES_BASE_PATH", "../evaluation_examples/examples")
    RESULTS_BASE_PATH = os.getenv("RESULTS_BASE_PATH", "../results")

MAX_STEPS = int(os.getenv("MAX_STEPS", "150"))

@cache
def get_default_config():
    """Get the first available configuration from results directory"""
    if os.path.exists(RESULTS_BASE_PATH):
        try:
            # Scan for the first available configuration
            for action_space in os.listdir(RESULTS_BASE_PATH):
                action_space_path = os.path.join(RESULTS_BASE_PATH, action_space)
                if os.path.isdir(action_space_path):
                    for obs_type in os.listdir(action_space_path):
                        obs_path = os.path.join(action_space_path, obs_type)
                        if os.path.isdir(obs_path):
                            for model_name in os.listdir(obs_path):
                                model_path = os.path.join(obs_path, model_name)
                                if os.path.isdir(model_path):
                                    # Get max_steps from args.json if available
                                    model_args = get_model_args(action_space, obs_type, model_name)
                                    max_steps = MAX_STEPS
                                    if model_args and 'max_steps' in model_args:
                                        max_steps = model_args['max_steps']
                                    
                                    print(f"Found default config: {action_space}/{obs_type}/{model_name} (max_steps: {max_steps})")
                                    return {
                                        'action_space': action_space,
                                        'observation_type': obs_type,
                                        'model_name': model_name,
                                        'max_steps': max_steps
                                    }
        except Exception as e:
            print(f"Error scanning results directory for default config: {e}")
    
    # Fallback to environment-based config if no configs found
    fallback_config = {
        'action_space': os.getenv("ACTION_SPACE", "pyautogui"),
        'observation_type': os.getenv("OBSERVATION_TYPE", "screenshot"),
        'model_name': os.getenv("MODEL_NAME", "computer-use-preview"),
        'max_steps': MAX_STEPS
    }
    print(f"Using fallback config from environment: {fallback_config['action_space']}/{fallback_config['observation_type']}/{fallback_config['model_name']} (max_steps: {fallback_config['max_steps']})")
    return fallback_config

def ensure_cache_initialized(action_space, observation_type, model_name):
    """Ensure cache is initialized for the given configuration"""
    results_path = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    if results_path not in TASK_STATUS_CACHE:
        TASK_STATUS_CACHE[results_path] = {}
    return results_path

@cache
def load_task_list():
    with open(TASK_CONFIG_PATH, 'r') as f:
        return json.load(f)

@cache
def get_task_info(task_type, task_id):
    task_file = os.path.join(EXAMPLES_BASE_PATH, task_type, f"{task_id}.json")
    if os.path.exists(task_file):
        with open(task_file, 'r') as f:
            return json.load(f)
    return None

def get_task_status_with_config(task_type, task_id, action_space, observation_type, model_name):
    results_path = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    max_steps = MAX_STEPS
    
    # Get max_steps from args.json if available
    model_args = get_model_args(action_space, observation_type, model_name)
    if model_args and 'max_steps' in model_args:
        max_steps = model_args['max_steps']
    
    result_dir = os.path.join(results_path, task_type, task_id)
    
    if not os.path.exists(result_dir):
        return {
            "status": "Not Started",
            "progress": 0,
            "total_steps": 0,
            "last_update": None
        }
    
    traj_file = os.path.join(result_dir, "traj.jsonl")
    log_file = os.path.join(result_dir, "runtime.log")
    result_file = os.path.join(result_dir, "result.txt")
    
    if not os.path.exists(traj_file):
        return {
            "status": "Preparing",
            "progress": 0,
            "total_steps": 0,
            "last_update": datetime.fromtimestamp(os.path.getmtime(result_dir)).strftime("%Y-%m-%d %H:%M:%S")
        }
    
    # read trajectory file
    steps = []
    with open(traj_file, 'r') as f:
        for line in f:
            if line.strip():
                steps.append(json.loads(line))
    
    if not steps:
        return {
            "status": "Initializing",
            "progress": 0,
            "total_steps": 0,
            "last_update": datetime.fromtimestamp(os.path.getmtime(traj_file)).strftime("%Y-%m-%d %H:%M:%S")
        }
    
    last_step = steps[-1]
    
    # Check the log file for agent responses and exit conditions
    log_data = {
        "agent_responses": [],
        "exit_condition": None,
        "last_message": None
    }
    
    if os.path.exists(log_file):
        try:
            with open(log_file, 'r') as f:
                log_content = f.readlines()
                last_response = None
                
                for line in log_content:
                    # Extract agent responses for each step
                    if "Responses: [" in line:
                        response_text = line.split("Responses: [")[1].strip()
                        if response_text.endswith("]"):
                            response_text = response_text[:-1]  # Remove closing bracket
                        
                        # Clean up the response text - remove quotes
                        if response_text.startswith("'") and response_text.endswith("'"):
                            response_text = response_text[1:-1]  # Remove surrounding quotes
                        elif response_text == '"]':  # Empty response
                            response_text = ""
                        
                        # Handle list of responses
                        if response_text and "', '" in response_text:
                            responses = [r.strip("'") for r in response_text.split("', '")]
                            log_data["agent_responses"].append(responses[0])  # Use first response
                            last_response = responses[0]  # Keep track of the last response
                        elif response_text:
                            log_data["agent_responses"].append(response_text)
                            last_response = response_text  # Keep track of the last response
                    
                    # Check for exit conditions near the end of the log
                    if "The state of the agent is not correct" in line or "Exit condition met" in line:
                        log_data["exit_condition"] = line.strip()
                        # If this is a message exit, save the last response as the last message
                        if "message_exit: True" in line and last_response:
                            log_data["last_message"] = last_response
        except Exception as e:
            log_data["error"] = f"Error parsing log file: {str(e)}"
    
    # check if the task is done based on both trajectory and log
    if last_step.get("done", False):
        status = "Done"
    elif last_step.get("Error", False):
        status = "Error"
    elif log_data.get("exit_condition") and "message_exit: True" in log_data.get("exit_condition", ""):
        status = "Done (Message Exit)"
    elif log_data.get("exit_condition") and "thought_exit: True" in log_data.get("exit_condition", ""):
        status = "Done (Thought Exit)"
    elif len(steps) >= max_steps:
        status = "Done (Max Steps)"
    else:
        status = "Running"
    
    # get last action timestamp
    try:
        last_update = datetime.strptime(last_step["action_timestamp"], "%Y%m%d@%H%M%S").strftime("%Y-%m-%d %H:%M:%S")
    except KeyError:
        last_update = "None"
    
    result_content = "Task not completed"
    if status.startswith("Done"):
        if os.path.exists(result_file):
            with open(result_file, 'r') as f:
                result_content = f.read().strip()
        else:
            result_content = "Result file not found"
    
    return {
        "status": status,
        "progress": len(steps),
        "max_steps": max_steps,
        "last_update": last_update,
        "steps": steps,
        "log_data": log_data,
        "result": result_content
    }

def get_task_status(task_type, task_id):
    # This function should not be used anymore - use get_task_status_with_config instead
    default_config = get_default_config()
    return get_task_status_with_config(task_type, task_id, 
                                     default_config['action_space'], 
                                     default_config['observation_type'], 
                                     default_config['model_name'])

def get_task_status_brief_with_config(task_type, task_id, action_space, observation_type, model_name):
    """
    Get brief status info for a task, without detailed step data, for fast homepage loading.
    """
    results_path = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    max_steps = MAX_STEPS
    
    # Get max_steps from args.json if available
    model_args = get_model_args(action_space, observation_type, model_name)
    if model_args and 'max_steps' in model_args:
        max_steps = model_args['max_steps']
    
    # Generate cache key based on task type, ID, and config
    cache_key = f"{task_type}_{task_id}_{action_space}_{observation_type}_{model_name}"
    
    # Check if the status is already cached
    current_time = time.time()
    last_cache_time = None
    if results_path in TASK_STATUS_CACHE and cache_key in TASK_STATUS_CACHE[results_path]:
        cached_status, cached_time = TASK_STATUS_CACHE[results_path][cache_key]
        last_cache_time = cached_time
        # If cached status is "Done", check if it's within the stability period
        if cached_status["status"].startswith("Done"):
            # If within stability period, recalculate status to ensure it's correct
            if current_time - cached_time < DONE_STABILITY_PERIOD:
                # Status is still in verification period, refresh it
                pass
            else:
                # Status is stable, return from cache
                return cached_status
        else:
            # For non-Done status (like Error), just return from cache
            return cached_status
    
    result_dir = os.path.join(results_path, task_type, task_id)
    
    if not os.path.exists(result_dir):
        return {
            "status": "Not Started",
            "progress": 0,
            "max_steps": max_steps,
            "last_update": None
        }
    
    traj_file = os.path.join(result_dir, "traj.jsonl")
    log_file = os.path.join(result_dir, "runtime.log")
    result_file = os.path.join(result_dir, "result.txt")
    
    if not os.path.exists(traj_file):
        return {
            "status": "Preparing",
            "progress": 0,
            "max_steps": max_steps,
            "last_update": datetime.fromtimestamp(os.path.getmtime(result_dir)).strftime("%Y-%m-%d %H:%M:%S")
        }
    
    # Get file line count and last line without reading the whole file
    import subprocess
    
    # Use wc -l to get line count
    try:
        result = subprocess.run(['wc', '-l', traj_file], capture_output=True, text=True)
        if result.returncode == 0:
            step_count = int(result.stdout.strip().split()[0])
        else:
            step_count = 0
    except:
        step_count = 0
    
    # Use tail -n 1 to get last line
    last_step_data = None
    if step_count > 0:
        try:
            result = subprocess.run(['tail', '-n', '1', traj_file], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                last_step_data = json.loads(result.stdout.strip())
        except:
            pass
    
    if step_count == 0:
        return {
            "status": "Initializing",
            "progress": 0,
            "max_steps": max_steps,
            "last_update": datetime.fromtimestamp(os.path.getmtime(traj_file)).strftime("%Y-%m-%d %H:%M:%S")
        }
    
    # Set default status to "Running"
    status = "Running"
    
    # Determine status from last step data
    if last_step_data:
        if last_step_data.get("done", False):
            status = "Done"
        elif last_step_data.get("Error", False):
            status = "Error"
    
    # If step count reaches max, consider as done
    if step_count >= max_steps:
        status = "Done (Max Steps)"
    
    # Quickly check exit condition in log file (only last few lines)
    if os.path.exists(log_file) and status == "Running":
        try:
            # Use tail to read last 2 lines of log file
            result = subprocess.run(['tail', '-n', '2', log_file], capture_output=True, text=True)
            if result.returncode == 0:
                log_tail = result.stdout
                if "message_exit: True" in log_tail:
                    status = "Done (Message Exit)"
                elif "thought_exit: True" in log_tail:
                    status = "Done (Thought Exit)"
        except:
            pass
    
    # If step count reaches max again (double check)
    if step_count >= max_steps:
        status = "Done (Max Steps)"
    
    # Get last update time
    last_update = "None"
    if last_step_data and "action_timestamp" in last_step_data:
        try:
            last_update = datetime.strptime(last_step_data["action_timestamp"], "%Y%m%d@%H%M%S").strftime("%Y-%m-%d %H:%M:%S")
        except:
            pass
    
    # Get result content if finished
    result_content = None
    if status.startswith("Done") and os.path.exists(result_file):
        try:
            with open(result_file, 'r') as f:
                result_content = f.read().strip()
        except:
            result_content = "Result file not found"
    
    status_dict = {
        "status": status,
        "progress": step_count,
        "max_steps": max_steps,
        "last_update": last_update,
        "result": result_content
    }
    
    # Initialize cache for this results path if it doesn't exist
    if results_path not in TASK_STATUS_CACHE:
        TASK_STATUS_CACHE[results_path] = {}
    
    # Cache the status if it is done or error
    if status.startswith("Done") or status == "Error":
        current_time = last_cache_time if last_cache_time else current_time
        TASK_STATUS_CACHE[results_path][cache_key] = (status_dict, current_time)
    
    return status_dict

def get_task_status_brief(task_type, task_id):
    """
    Get brief status info for a task, without detailed step data, for fast homepage loading.
    """
    # This function should not be used anymore - use get_task_status_brief_with_config instead
    default_config = get_default_config()
    return get_task_status_brief_with_config(task_type, task_id, 
                                           default_config['action_space'], 
                                           default_config['observation_type'], 
                                           default_config['model_name'])
    

def get_all_tasks_status():
    task_list = load_task_list()
    result = {}
    
    for task_type, task_ids in task_list.items():
        result[task_type] = []
        for task_id in task_ids:
            task_info = get_task_info(task_type, task_id)
            task_status = get_task_status(task_type, task_id)
            
            if task_info:
                result[task_type].append({
                    "id": task_id,
                    "instruction": task_info.get("instruction", "No instruction provided"),
                    "status": task_status
                })
            else:
                result[task_type].append({
                    "id": task_id,
                    "instruction": "No task info available",
                    "status": task_status
                })
    
    return result

def get_all_tasks_status_with_config(action_space, observation_type, model_name):
    task_list = load_task_list()
    result = {}
    
    for task_type, task_ids in task_list.items():
        result[task_type] = []
        for task_id in task_ids:
            task_info = get_task_info(task_type, task_id)
            task_status = get_task_status_with_config(task_type, task_id, action_space, observation_type, model_name)
            
            if task_info:
                result[task_type].append({
                    "id": task_id,
                    "instruction": task_info.get("instruction", "No instruction provided"),
                    "status": task_status
                })
            else:
                result[task_type].append({
                    "id": task_id,
                    "instruction": "No task info available",
                    "status": task_status
                })
    
    return result

def get_all_tasks_status_brief_with_config(action_space, observation_type, model_name):
    """
    Get brief status info for all tasks, without detailed step data, for fast homepage loading.
    """
    task_list = load_task_list()
    result = {}
    
    for task_type, task_ids in task_list.items():
        result[task_type] = []
        for task_id in task_ids:
            task_info = get_task_info(task_type, task_id)
            task_status = get_task_status_brief_with_config(task_type, task_id, action_space, observation_type, model_name)
            
            if task_info:
                result[task_type].append({
                    "id": task_id,
                    "instruction": task_info.get("instruction", "No instruction provided"),
                    "status": task_status
                })
            else:
                result[task_type].append({
                    "id": task_id,
                    "instruction": "No task info available",
                    "status": task_status
                })
    
    return result

def get_all_tasks_status_brief():
    """
    Get brief status info for all tasks, without detailed step data, for fast homepage loading.
    """
    task_list = load_task_list()
    result = {}
    
    for task_type, task_ids in task_list.items():
        result[task_type] = []
        for task_id in task_ids:
            task_info = get_task_info(task_type, task_id)
            task_status = get_task_status_brief(task_type, task_id)
            
            if task_info:
                result[task_type].append({
                    "id": task_id,
                    "instruction": task_info.get("instruction", "No instruction provided"),
                    "status": task_status
                })
            else:
                result[task_type].append({
                    "id": task_id,
                    "instruction": "No task info available",
                    "status": task_status
                })
    
    return result

@app.route('/')
def index():
    return render_template("index.html")

@app.route('/task/<task_type>/<task_id>')
def task_detail(task_type, task_id):
    # Get config from URL parameters
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    task_info = get_task_info(task_type, task_id)
    task_status = get_task_status_with_config(task_type, task_id, action_space, observation_type, model_name)
    
    if not task_info:
        return "Task not found", 404
    
    return render_template("task_detail.html", 
                            task_id=task_id, 
                            task_type=task_type, 
                            task_info=task_info, 
                            task_status=task_status,
                            action_space=action_space,
                            observation_type=observation_type,
                            model_name=model_name)

@app.route('/api/tasks')
def api_tasks():
    """Task status API"""
    # Get config from URL parameters
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    return jsonify(get_all_tasks_status_with_config(action_space, observation_type, model_name))

@app.route('/api/tasks/brief')
def api_tasks_brief():
    """Return brief status info for all tasks, without detailed step data, for fast homepage loading."""
    # Get config from URL parameters
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    return jsonify(get_all_tasks_status_brief_with_config(action_space, observation_type, model_name))

@app.route('/task/<task_type>/<task_id>/screenshot/<path:filename>')
def task_screenshot(task_type, task_id, filename):
    """Get task screenshot"""
    # Get config from URL parameters
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    results_path = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    screenshot_path = os.path.join(results_path, task_type, task_id, filename)
    if os.path.exists(screenshot_path):
        return send_file(screenshot_path, mimetype='image/png')
    else:
        return "Screenshot does not exist", 404

@app.route('/task/<task_type>/<task_id>/recording')
def task_recording(task_type, task_id):
    """Get task recording video"""
    # Get config from URL parameters
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    results_path = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    recording_path = os.path.join(results_path, task_type, task_id, "recording.mp4")
    if os.path.exists(recording_path):
        response = send_file(recording_path, mimetype='video/mp4')
        # Add headers to improve mobile compatibility
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Cache-Control'] = 'public, max-age=3600'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response
    else:
        return "Recording does not exist", 404

@app.route('/api/task/<task_type>/<task_id>')
def api_task_detail(task_type, task_id):
    """Task detail API"""
    # Get config from URL parameters
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    task_info = get_task_info(task_type, task_id)
    task_status = get_task_status_with_config(task_type, task_id, action_space, observation_type, model_name)
    
    if not task_info:
        return jsonify({"error": "Task does not exist"}), 404
    
    return jsonify({
        "info": task_info,
        "status": task_status
    })

@app.route('/api/config')
def api_config():
    """Get configuration information from environment variables - deprecated, use /api/current-config instead"""
    config_info = {
        "task_config_path": TASK_CONFIG_PATH,
        "results_base_path": RESULTS_BASE_PATH,
        "action_space": get_default_config()['action_space'],
        "observation_type": get_default_config()['observation_type'],
        "model_name": get_default_config()['model_name'],
        "max_steps": MAX_STEPS,
        "examples_base_path": EXAMPLES_BASE_PATH
    }
    return jsonify(config_info)

@app.route('/api/available-configs')
def api_available_configs():
    """Get all available configuration combinations by scanning the results directory"""
    configs = []
    
    if os.path.exists(RESULTS_BASE_PATH):
        try:
            # Scan action spaces
            for action_space in os.listdir(RESULTS_BASE_PATH):
                action_space_path = os.path.join(RESULTS_BASE_PATH, action_space)
                if os.path.isdir(action_space_path):
                    # Scan observation types
                    for obs_type in os.listdir(action_space_path):
                        obs_path = os.path.join(action_space_path, obs_type)
                        if os.path.isdir(obs_path):
                            # Scan model names
                            for model_name in os.listdir(obs_path):
                                model_path = os.path.join(obs_path, model_name)
                                if os.path.isdir(model_path):
                                    configs.append({
                                        "action_space": action_space,
                                        "observation_type": obs_type,
                                        "model_name": model_name,
                                        "path": model_path
                                    })
        except Exception as e:
            print(f"Error scanning results directory: {e}")
    
    return jsonify(configs)

@app.route('/api/current-config')
def api_current_config():
    """Get current configuration including args.json data"""
    # Get config from URL parameters or use defaults
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    # Get max_steps from args.json if available
    model_args = get_model_args(action_space, observation_type, model_name)
    max_steps = MAX_STEPS
    if model_args and 'max_steps' in model_args:
        max_steps = model_args['max_steps']
    
    config = {
        "action_space": action_space,
        "observation_type": observation_type,
        "model_name": model_name,
        "max_steps": max_steps,
        "results_path": os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    }
    
    # Add model args from args.json
    if model_args:
        config["model_args"] = model_args
    else:
        config["model_args"] = {}
    
    return jsonify(config)


def get_model_args(action_space, observation_type, model_name):
    """Get model arguments from args.json file"""
    args_file = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name, "args.json")
    if os.path.exists(args_file):
        try:
            with open(args_file, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error reading args.json: {e}")
    return None

@app.route('/api/clear-cache', methods=['POST'])
def api_clear_cache():
    """Clear task status cache for current configuration"""
    global TASK_STATUS_CACHE
    
    # Get config from URL parameters or use defaults
    default_config = get_default_config()
    action_space = request.args.get('action_space', default_config['action_space'])
    observation_type = request.args.get('observation_type', default_config['observation_type'])
    model_name = request.args.get('model_name', default_config['model_name'])
    
    results_path = os.path.join(RESULTS_BASE_PATH, action_space, observation_type, model_name)
    
    # Clear cache only for the current configuration
    if results_path in TASK_STATUS_CACHE:
        TASK_STATUS_CACHE[results_path].clear()
        message = f"Cache cleared for configuration: {action_space}/{observation_type}/{model_name}"
    else:
        message = f"No cache found for configuration: {action_space}/{observation_type}/{model_name}"
    
    return jsonify({"message": message})

if __name__ == '__main__':
    # Check if necessary directories exist
    if not os.path.exists(TASK_CONFIG_PATH):
        print(f"Warning: Task config file does not exist: {TASK_CONFIG_PATH}")
    
    if not os.path.exists(EXAMPLES_BASE_PATH):
        print(f"Warning: Task examples directory does not exist: {EXAMPLES_BASE_PATH}")
    
    # Start web service
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = os.getenv("FLASK_PORT", 8080)
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    
    app.run(host=host, port=port, debug=debug, threaded=True)