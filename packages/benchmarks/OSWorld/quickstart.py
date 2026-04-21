from desktop_env.desktop_env import DesktopEnv
import argparse

example = {
    "id": "94d95f96-9699-4208-98ba-3c3119edf9c2",
    "instruction": "I want to install Spotify on my current system. Could you please help me?",
    "config": [
        {
            "type": "execute",
            "parameters": {
                "command": [
                    "python",
                    "-c",
                    "import pyautogui; import time; pyautogui.click(960, 540); time.sleep(0.5);"
                ]
            }
        }
    ],
    "evaluator": {
        "func": "check_include_exclude",
        "result": {
            "type": "vm_command_line",
            "command": "which spotify"
        },
        "expected": {
            "type": "rule",
            "rules": {
                "include": ["spotify"],
                "exclude": ["not found"]
            }
        }
    }
}

# Parse arguments
parser = argparse.ArgumentParser()
parser.add_argument("--provider_name", type=str, default="vmware")
parser.add_argument("--path_to_vm", type=str, default=None)
parser.add_argument("--os_type", type=str, default="Ubuntu")
parser.add_argument("--action_space", type=str, default="pyautogui")
parser.add_argument("--headless", type=bool, default=False) # Set to True if you want to run without GUI
args = parser.parse_args()

# Initialize DesktopEnv
env = DesktopEnv(
    provider_name=args.provider_name,
    path_to_vm=args.path_to_vm,
    os_type=args.os_type,
    action_space=args.action_space,
    headless=args.headless  
)

print("Starting OSWorld environment...")
obs = env.reset(task_config=example)
print("Environment reset complete!")

print("Executing action: pyautogui.rightClick()")
obs, reward, done, info = env.step("pyautogui.rightClick()")
print("Action executed successfully!")

# Clean up
env.close()
print("Environment closed.")