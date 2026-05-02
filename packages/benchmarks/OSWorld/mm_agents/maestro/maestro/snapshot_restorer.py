#!/usr/bin/env python3
"""
Snapshot Restore Tool - Restore snapshots and create GlobalState
"""

import os
import sys
import json
from pathlib import Path
import time
from typing import Optional, Dict, Any, Tuple

# Add project root directory to Python path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from .simple_snapshot import SimpleSnapshot
from .new_global_state import NewGlobalState
from .controller.main_controller import MainController
from desktop_env.desktop_env import DesktopEnv


def _load_task_config_by_id(os_word_task_id: str, os_type_value: Optional[str] = None, test_config_base_dir: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Automatically load task configuration by task ID
    
    Args:
        os_word_task_id: Task ID
        os_type_value: OS type value
        test_config_base_dir: Test configuration base directory, if None then auto-detect
        
    Returns:
        Task configuration dictionary, returns None if not found
    """
    try:
        # If no base directory specified, auto-detect
        if test_config_base_dir is None:
            current_platform = os_type_value
            if current_platform == "Ubuntu":
                test_config_base_dir = os.path.join(project_root, "evaluation_examples", "examples")
            else:
                print(f"⚠️ Unable to determine platform type: {current_platform}")
                return None
        
        # Iterate through all domain directories to find task configuration
        # First search in the specified directory
        for domain_dir in os.listdir(test_config_base_dir):
            domain_path = os.path.join(test_config_base_dir, domain_dir)
            if os.path.isdir(domain_path):
                config_file = os.path.join(domain_path, f"{os_word_task_id}.json")
                if os.path.exists(config_file):
                    with open(config_file, "r", encoding="utf-8") as f:
                        task_config = json.load(f)
                    print(f"✅ Found task configuration: {domain_dir}/{os_word_task_id}.json")
                    return task_config
        
        # If not found in specified directory, try searching in another directory
        if "examples_windows" in test_config_base_dir:
            fallback_dir = os.path.join(project_root, "evaluation_examples", "examples")
        else:
            fallback_dir = os.path.join(project_root, "evaluation_examples", "examples_windows")
        
        if os.path.exists(fallback_dir):
            for domain_dir in os.listdir(fallback_dir):
                domain_path = os.path.join(fallback_dir, domain_dir)
                if os.path.isdir(domain_path):
                    config_file = os.path.join(domain_path, f"{os_word_task_id}.json")
                    if os.path.exists(config_file):
                        with open(config_file, "r", encoding="utf-8") as f:
                            task_config = json.load(f)
                        print(f"✅ Found task configuration in fallback directory: {domain_dir}/{os_word_task_id}.json")
                        return task_config
        
        print(f"❌ Configuration file not found for task ID: {os_word_task_id}")
        return None
        
    except Exception as e:
        print(f"❌ Failed to load task configuration: {e}")
        return None


def _build_env_from_config(env_config: Dict[str, Any], os_word_task_id: Optional[str] = None) -> Optional[DesktopEnv]:
    """
    Rebuild DesktopEnv from snapshot env configuration. Returns None on failure.
    
    Args:
        env_config: Environment configuration dictionary
        os_word_task_id: Task ID, if provided will automatically load task configuration and set up environment
    """
    try:
        if not env_config or not env_config.get("present"):
            return None

        provider_name = env_config.get("provider_name", "vmware")
        path_to_vm = env_config.get("path_to_vm")
        action_space = env_config.get("action_space", "pyautogui")
        headless = bool(env_config.get("headless", False))
        require_a11y_tree = bool(env_config.get("require_a11y_tree", False))
        os_type_value = env_config.get("os_type") or os.getenv("USE_PRECREATE_VM", "Ubuntu")

        if not path_to_vm:
            # Cannot build when missing required VM path
            return None

        env = DesktopEnv(
            provider_name=provider_name,
            path_to_vm=path_to_vm,
            action_space=action_space,
            headless=headless,
            require_a11y_tree=require_a11y_tree,
            os_type=os_type_value,
        )
        
        # If task ID provided, automatically load task configuration and set up environment
        if os_word_task_id:
            print(f"🔄 Loading configuration and setting up environment for task {os_word_task_id}...")
            task_config = _load_task_config_by_id(os_word_task_id, os_type_value)
            if task_config:
                try:
                    # Call reset method to set task configuration
                    env.reset(task_config=task_config)
                    time.sleep(10)
                    print(f"✅ Task {os_word_task_id} environment setup completed")
                    print("task_config", task_config)
                except Exception as e:
                    print(f"⚠️ Task environment setup failed (will continue running without task configuration): {e}")
            else:
                print(f"⚠️ Unable to load configuration for task {os_word_task_id}, will continue running without task configuration")
        else:
            # If needed, call reset to ensure internal state is ready
            try:
                env.reset()
            except Exception:
                pass
                
        return env
    except Exception as e:
        print(f"❌ Environment build failed: {e}")
        return None


def restore_snapshot_and_create_globalstate(runtime_dir: str, snapshot_id: Optional[str] = None, target_dir: Optional[str] = None):
    """
    Restore snapshot and create GlobalState
    
    Args:
        runtime_dir: Runtime directory path
        snapshot_id: Snapshot ID, if None then list all snapshots for selection
        target_dir: Target restore directory, if None then auto-generate
    """
    # Create snapshot system
    snapshot_system = SimpleSnapshot(runtime_dir)
    
    # If no snapshot ID specified, list all snapshots for selection
    if snapshot_id is None:
        snapshots = snapshot_system.list_snapshots()
        if not snapshots:
            print("❌ No snapshots found")
            return None, None, {}
        
        print("📋 Available snapshots:")
        for i, snapshot in enumerate(snapshots):
            print(f"  {i+1}. {snapshot['snapshot_id']}")
            print(f"     Description: {snapshot['description']}")
            print(f"     Type: {snapshot['type']}")
            print(f"     Time: {snapshot['timestamp']}")
            print()

    
    print(f"🔄 Restoring snapshot: {snapshot_id}")
    
    # Restore snapshot
    restore_result = snapshot_system.restore_snapshot(
        str(snapshot_id), target_dir
    )

    target_path = restore_result.get('target_directory')
    
    if not restore_result or not target_path:
        print("❌ Snapshot restore failed")
        return None, None, {}
    
    print(f"✅ Snapshot restore successful!")
    print(f"   Target directory: {target_path}")
    
    # Create GlobalState object
    try:
        # Build paths
        state_dir = Path(target_path) / "state"
        cache_dir = Path(target_path) / "cache"
        screens_dir = cache_dir / "screens"
        display_path = Path(target_path) / "display.json"
        
        # Ensure directories exist
        state_dir.mkdir(exist_ok=True)
        screens_dir.mkdir(parents=True, exist_ok=True)
        
        # Create GlobalState
        global_state = NewGlobalState(
            screenshot_dir=str(screens_dir),
            state_dir=str(state_dir),
            display_info_path=str(display_path)
        )
        
        print(f"🎉 GlobalState created successfully!")
        print(f"   Screenshot directory: {screens_dir}")
        print(f"   State directory: {state_dir}")
        print(f"   Display file: {display_path}")
        
        # Display configuration parameters
        config_params = restore_result.get("config_params", {})
        if config_params:
            print(f"\n📋 Snapshot configuration parameters:")
            print(f"   Platform: {config_params.get('platform', 'N/A')}")
            print(f"   Backend: {config_params.get('backend', 'N/A')}")
            print(f"   Max steps: {config_params.get('max_steps', 'N/A')}")
            print(f"   Search enabled: {config_params.get('enable_search', 'N/A')}")
            print(f"   Takeover enabled: {config_params.get('enable_takeover', 'N/A')}")
            print(f"   RAG enabled: {config_params.get('enable_rag', 'N/A')}")
        
        return global_state, target_path, config_params
        
    except Exception as e:
        print(f"❌ Failed to create GlobalState: {e}")
        return None, target_path, {}


def restore_maincontroller_from_globalstate(
    runtime_dir: str,
    snapshot_id: Optional[str] = None,
    target_dir: Optional[str] = None,
    os_word_task_id: Optional[str] = None
    ) -> Optional[Tuple[MainController, str, Dict[str, Any]]]:
    """
    Restore snapshot -> Build GlobalState -> Build MainController (skip initialization), and return controller, restore directory and configuration
    """
    global_state, target_path, config_params = restore_snapshot_and_create_globalstate(runtime_dir, snapshot_id, target_dir)
    if global_state is None:
        return None

    # Extract controller-related settings from configuration parameters (provide reasonable defaults)
    platform_value = config_params.get("platform", sys.platform)
    backend_value = config_params.get("backend", "pyautogui")
    enable_search_value = bool(config_params.get("enable_search", False))
    enable_takeover_value = bool(config_params.get("enable_takeover", False))
    enable_rag_value = bool(config_params.get("enable_rag", False))
    max_steps_value = int(config_params.get("max_steps", 50))
    env_password_value = config_params.get("env_password", "osworld-public-evaluation")

    # Protective check: target_path needs to be available
    if not target_path:
        print("❌ Unable to determine restore directory target_path")
        return None

    # Try to extract task ID from GlobalState if user hasn't manually specified one
    if os_word_task_id is None:
        print(f"⚠️ No need to load task configuration")
    else:
        print(f"📋 Using user-specified task ID: {os_word_task_id}")

    # Restore environment information: prioritize env configuration from snapshot
    env: Optional[DesktopEnv] = None
    try:
        env_config = config_params.get("env") or {}
        env = _build_env_from_config(env_config, os_word_task_id)
    except Exception as e:
        print(f"⚠️ Environment restore failed (will continue running without environment): {e}")
        env = None

    controller = MainController(
        platform=platform_value,
        enable_takeover=enable_takeover_value,
        enable_search=enable_search_value,
        enable_rag=enable_rag_value,
        backend=backend_value,
        user_query=(global_state.get_task().objective if hasattr(global_state, 'get_task') else ""),
        max_steps=max_steps_value,
        env=env,
        env_password=env_password_value,
        log_dir=str(Path(target_path)),
        datetime_str=Path(target_path).name,
        enable_snapshots=True,
        global_state=global_state,
        initialize_controller=False
    )

    print("✅ MainController restored from snapshot, ready to execute main loop")
    return controller, target_path, config_params



def main():
    """Main function"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Snapshot restore tool")
    parser.add_argument("runtime_dir", help="Runtime directory path")
    parser.add_argument("--snapshot", "-s", help="Snapshot ID")
    parser.add_argument("--target", "-t", help="Target restore directory")
    parser.add_argument("--task-id", help="Task ID for automatically loading task configuration and setting up environment")
    parser.add_argument("--run", action="store_true", help="Run main loop immediately after restore")
    
    args = parser.parse_args()
    
    # Check if runtime directory exists
    if not Path(args.runtime_dir).exists():
        print(f"❌ Runtime directory does not exist: {args.runtime_dir}")
        return
    
    if args.run:
        result = restore_maincontroller_from_globalstate(args.runtime_dir, args.snapshot, args.target, args.task_id)
        if result is not None:
            controller, target_path, _ = result
            controller.execute_main_loop()
        return
    
    # Only restore snapshot and create GlobalState
    global_state, target_path, _ = restore_snapshot_and_create_globalstate(
        args.runtime_dir, args.snapshot, args.target
    )
    
    if global_state:
        print(f"\n🎯 Usage instructions:")
        print(f"   1. GlobalState object created, can be used directly")
        print(f"   2. Restored directory: {target_path}")
        print(f"   3. Can call global_state.get_task() and other methods to read information")
        print(f"   4. All state files restored to: {target_path}/state/")
        print(f"   5. Screenshots restored to: {target_path}/cache/screens/")
        print(f"   6. Call restore_maincontroller_from_globalstate(...).execute_main_loop() to continue execution")
        if args.task_id:
            print(f"   7. Task ID specified: {args.task_id}, will automatically load task configuration")


if __name__ == "__main__":
    main()