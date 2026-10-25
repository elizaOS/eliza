"""
Main Controller for Maestro
Integrates all modules and provides a unified interface
"""

import time
import os
import logging
from datetime import datetime
from typing import Dict, Any, Optional, List
import platform

from ..Action import Screenshot

from ..data_models import SubtaskData, TaskData
from desktop_env.desktop_env import DesktopEnv
from ..hardware_interface import HardwareInterface
from PIL import Image

from ..utils.screenShot import scale_screenshot_dimensions
from ...store.registry import Registry

from ..new_global_state import NewGlobalState
from ..new_manager import NewManager
from ..new_executor import NewExecutor
from ..enums import ControllerState, TaskStatus, SubtaskStatus, TriggerCode, TriggerRole

from .config_manager import ConfigManager
from .rule_engine import RuleEngine
from .state_handlers import StateHandlers
from .state_machine import StateMachine

logger = logging.getLogger(__name__)


class MainController:
    """Main controller that integrates all modules and provides a unified interface"""
    
    def __init__(
        self,
        platform: str = platform.system().lower(),
        memory_root_path: str = os.getcwd(),
        memory_folder_name: str = "kb_s2",
        kb_release_tag: str = "v0.2.2",
        enable_takeover: bool = False,
        enable_search: bool = False,
        enable_rag: bool = False,
        backend: str = "pyautogui",
        user_query: str = "",
        max_steps: int = 50,
        env: Optional[DesktopEnv] = None,
        env_password: str = "osworld-public-evaluation",
        log_dir: str = "logs",
        datetime_str: str = datetime.now().strftime("%Y%m%d_%H%M%S"),
        enable_snapshots: bool = True,
        snapshot_interval: int = 10,  # Automatically create snapshot every N steps
        create_checkpoint_snapshots: bool = True,  # Whether to create checkpoint snapshots at key states
        global_state: Optional[NewGlobalState] = None,  # New: Allow injection of existing global state (for snapshot recovery)
        initialize_controller: bool = True  # New: Whether to execute initialization process (skip when recovering from snapshot)
    ):
        # Snapshot configuration
        self.enable_snapshots = enable_snapshots
        self.snapshot_interval = snapshot_interval
        self.create_checkpoint_snapshots = create_checkpoint_snapshots
        self.last_snapshot_step = 0
        
        # Initialize global state (support external injection)
        if global_state is not None:
            self.global_state = global_state
        else:
            self.global_state = self._registry_global_state(log_dir, datetime_str)
        
        # Basic configuration
        self.platform = platform
        self.user_query = user_query
        self.max_steps = max_steps
        self.env = env
        self.env_password = env_password
        self.enable_search = enable_search
        self.enable_takeover = enable_takeover
        self.enable_rag = enable_rag
        self.backend = backend
        
        # Initialize configuration manager
        self.config_manager = ConfigManager(memory_root_path, memory_folder_name)
        self.tools_dict = self.config_manager.load_tools_configuration()
        self.local_kb_path = self.config_manager.setup_knowledge_base(platform)
        # New: Load flow configuration and override default parameters
        self.flow_config = self.config_manager.get_flow_config()
        self.max_steps = self.flow_config.get("max_steps", self.max_steps)
        self.enable_snapshots = self.flow_config.get("enable_snapshots", self.enable_snapshots)
        self.snapshot_interval = self.flow_config.get("snapshot_interval_steps", self.snapshot_interval)
        self.create_checkpoint_snapshots = self.flow_config.get("create_checkpoint_snapshots", self.create_checkpoint_snapshots)
        self.main_loop_sleep_secs = self.flow_config.get("main_loop_sleep_secs", 0.1)
        
        # Initialize manager
        manager_params = {
            "tools_dict": self.tools_dict,
            "global_state": self.global_state,
            "local_kb_path": self.local_kb_path,
            "platform": self.platform,
            "enable_search": enable_search
        }
        self.manager = NewManager(**manager_params)

        # Initialize hardware interface
        backend_kwargs = {
            "platform": platform, 
            "env_controller": self.env
        }
        self.hwi = HardwareInterface(backend=backend, **backend_kwargs)
        logger.info(f"Hardware interface initialized with backend: {backend}")

        # Initialize executor
        executor_params = {
            "global_state": self.global_state,
            "hardware_interface": self.hwi,
            "env_controller": self.env
        }
        self.executor = NewExecutor(**executor_params)
        logger.info("Executor initialized")
        
        # Initialize rule engine
        rule_engine_params: Dict[str, Any] = dict(
            global_state=self.global_state,
            max_steps=self.max_steps,
            max_state_switches=self.flow_config.get("max_state_switches", 500),
            max_state_duration=self.flow_config.get("max_state_duration_secs", 300),
            flow_config=self.flow_config,
        )
        self.rule_engine = RuleEngine(**rule_engine_params)
        
        # Initialize state handlers
        state_handlers_params: Dict[str, Any] = dict(
            global_state=self.global_state,
            manager=self.manager,
            executor=self.executor,
            tools_dict=self.tools_dict,
            platform=self.platform,
            enable_search=enable_search,
            env_password=self.env_password,
            rule_engine=self.rule_engine
        )
        self.state_handlers = StateHandlers(**state_handlers_params)
        
        # Initialize state machine
        state_machine_params: Dict[str, Any] = dict(
            global_state=self.global_state,
            rule_engine=self.rule_engine,
            state_handlers=self.state_handlers
        )
        self.state_machine = StateMachine(**state_machine_params)
        
        # Initialize counters
        self.reset_counters()
        
        # Initialize task and initial snapshot (can be skipped for snapshot recovery)
        if initialize_controller:
            # Initialize task and generate first screenshot
            self._handle_task_init()
            
            # Create initial snapshot
            if self.enable_snapshots:
                self._create_initial_snapshot()

    def _registry_global_state(self, log_dir: str, datetime_str: str):
        """Register global state"""
        # Ensure necessary directory structure exists
        timestamp_dir = os.path.join(log_dir, datetime_str)
        cache_dir = os.path.join(timestamp_dir, "cache", "screens")
        state_dir = os.path.join(timestamp_dir, "state")

        os.makedirs(cache_dir, exist_ok=True)
        os.makedirs(state_dir, exist_ok=True)

        global_state = NewGlobalState(
            screenshot_dir=cache_dir,
            state_dir=state_dir,
            display_info_path=os.path.join(timestamp_dir, "display.json")
        )
        Registry.register("GlobalStateStore", global_state)
        return global_state
    
    def _handle_task_init(self):
        """Handle task initialization state"""
        logger.info("Handling INIT state")
        self.global_state.set_task_objective(self.user_query)
        # Initialize controller state
        self.global_state.reset_controller_state()
        logger.info("MainController initialized")
        
        # wait for environment to setup
        time.sleep(10)
        
        # Get first screenshot
        screenshot: Image.Image = self.hwi.dispatch(Screenshot())  # type: ignore
        self.global_state.set_screenshot(scale_screenshot_dimensions(screenshot, self.hwi))
    
    def _build_env_config(self) -> Dict[str, Any]:
        """Build serializable environment configuration for rebuilding DesktopEnv during snapshot recovery.
        Only record key fields needed for reconstruction, avoiding storing sensitive information.
        """
        env_config: Dict[str, Any] = {"present": False}
        try:
            if self.env is None:
                return env_config
            env_config["present"] = True
            # Basic information
            env_config["class_name"] = self.env.__class__.__name__
            # Key fields (safely get using getattr)
            for key in [
                "provider_name",
                "os_type",
                "action_space",
                "headless",
                "require_a11y_tree",
                "require_terminal",
                "snapshot_name",
            ]:
                value = getattr(self.env, key, None)
                if value is not None:
                    env_config[key] = value
            # Path fields: may be relative paths, try to store as absolute paths
            path_to_vm = getattr(self.env, "path_to_vm", None)
            if path_to_vm:
                try:
                    env_config["path_to_vm"] = os.path.abspath(path_to_vm)
                except Exception:
                    env_config["path_to_vm"] = path_to_vm
            # Resolution
            screen_width = getattr(self.env, "screen_width", None)
            screen_height = getattr(self.env, "screen_height", None)
            if screen_width and screen_height:
                env_config["screen_size"] = [int(screen_width), int(screen_height)]
        except Exception:
            # Don't block snapshot due to environment serialization failure
            logger.debug("Failed to build env config for snapshot", exc_info=True)
        return env_config

    def _base_snapshot_config(self) -> Dict[str, Any]:
        """Uniformly build snapshot configuration parameters, including existing configuration and environment information."""
        return {
            "tools_dict": self.tools_dict,
            "platform": self.platform,
            "enable_search": self.enable_search,
            "env_password": self.env_password,
            "enable_takeover": self.enable_takeover,
            "enable_rag": self.enable_rag,
            "backend": self.backend,
            "max_steps": self.max_steps,
            "env": self._build_env_config(),
        }

    def _create_initial_snapshot(self):
        """Create initial snapshot"""
        try:
            if self.enable_snapshots:
                # Prepare configuration parameters
                config_params = self._base_snapshot_config()
                
                snapshot_id = self.global_state.create_snapshot(
                    description=f"Initial state for task: {self.user_query}",
                    snapshot_type="initial",
                    config_params=config_params
                )
                logger.info(f"Initial snapshot created: {snapshot_id}")
        except Exception as e:
            logger.warning(f"Failed to create initial snapshot: {e}")

    def _should_create_auto_snapshot(self) -> bool:
        """Determine whether to create automatic snapshot"""
        if not self.enable_snapshots:
            return False
        
        task = self.global_state.get_task()
        current_step = task.step_num if task else 0
        return (current_step - self.last_snapshot_step) >= self.snapshot_interval

    def _create_auto_snapshot(self):
        """Create automatic snapshot"""
        try:
            if self._should_create_auto_snapshot():
                task = self.global_state.get_task()
                current_step = task.step_num if task else 0
                
                # Prepare configuration parameters
                config_params = self._base_snapshot_config()
                
                snapshot_id = self.global_state.create_snapshot(
                    description=f"Auto snapshot at step {current_step}",
                    snapshot_type="auto",
                    config_params=config_params
                )
                self.last_snapshot_step = current_step
                logger.debug(f"Auto snapshot created: {snapshot_id}")
        except Exception as e:
            logger.warning(f"Failed to create auto snapshot: {e}")

    def _create_checkpoint_snapshot(self, checkpoint_name: str = ""):
        """Create checkpoint snapshot"""
        try:
            if self.enable_snapshots and self.create_checkpoint_snapshots:
                task = self.global_state.get_task()
                current_step = task.step_num if task else 0
                
                if not checkpoint_name:
                    checkpoint_name = f"checkpoint_step_{current_step}"
                
                # Prepare configuration parameters
                config_params = self._base_snapshot_config()
                
                snapshot_id = self.global_state.create_snapshot(
                    description=f"Checkpoint: {checkpoint_name}",
                    snapshot_type="checkpoint",
                    config_params=config_params
                )
                logger.info(f"Checkpoint snapshot created: {snapshot_id}")
                return snapshot_id
        except Exception as e:
            logger.warning(f"Failed to create checkpoint snapshot: {e}")
        return None

    def _create_error_snapshot(self, error_message: str, error_type: str = "unknown"):
        """Create error snapshot"""
        try:
            if self.enable_snapshots:
                # Prepare configuration parameters
                config_params = self._base_snapshot_config()
                
                snapshot_id = self.global_state.create_snapshot(
                    description=f"Error: {error_message}",
                    snapshot_type=f"error_{error_type}",
                    config_params=config_params
                )
                logger.info(f"Error snapshot created: {snapshot_id}")
                return snapshot_id
        except Exception as e:
            logger.warning(f"Failed to create error snapshot: {e}")
        return None

    def _handle_snapshot_creation(self, current_state: ControllerState):
        """Handle snapshot creation logic"""
        if not self.enable_snapshots:
            return
        
        try:
            # Check if should create automatic snapshot
            self._create_auto_snapshot()
            
            # In key states create checkpoint snapshot
            if self.create_checkpoint_snapshots:
                if current_state in [ControllerState.PLAN, ControllerState.QUALITY_CHECK, ControllerState.FINAL_CHECK, ControllerState.GET_ACTION]:
                    self._create_checkpoint_snapshot(f"checkpoint_{current_state.value.lower()}")
                    
        except Exception as e:
            logger.warning(f"Error in snapshot creation: {e}")
    
    def execute_single_step(self, steps: int = 1) -> None:
        """Single step execution logic (execute steps steps, do not enter loop)"""
        if steps is None or steps <= 0:
            steps = 1
            
        try:
            for step_index in range(steps):
                # 1. Check if should terminate (single step sequence)
                if self.state_machine.should_exit_loop():
                    logger.info("Task fulfilled or rejected, terminating single step batch")
                    break

                # 2. Get current state
                current_state = self.state_machine.get_current_state()
                logger.info(f"Current state (single step {step_index + 1}/{steps}): {current_state}")

                # 3. Handle snapshot creation
                self._handle_snapshot_creation(current_state)

                # 4. According to state execute appropriate handling (once step by step)
                self._handle_state(current_state)

                # 5. Each step ends, handle rules and update states
                self.state_machine.process_rules_and_update_states()

        except Exception as e:
            logger.error(f"Error in single step batch: {e}")
            # Create error snapshot
            self._create_error_snapshot(str(e), "single_step_batch")
            
            self.global_state.add_event(
                "controller", "error", f"Single step batch error: {str(e)}")
            # Error recovery: back to INIT state (single step sequence)
            self.state_machine.switch_state(
                ControllerState.INIT, TriggerRole.CONTROLLER, f"Error recovery from single step batch: {str(e)}", TriggerCode.ERROR_RECOVERY)
    
    def execute_main_loop(self) -> None:
        """Main loop execution - based on state state machine"""
        logger.info("Starting main loop execution")

        # Record main loop start time
        main_loop_start_time = time.time()
        while True:
            try:
                # print("execute_main_loop")
                # 1. Check if should exit loop
                if self.state_machine.should_exit_loop():
                    logger.info("Task fulfilled or rejected, breaking main loop")
                    break

                # 2. Get current state
                current_state = self.state_machine.get_current_state()

                # 3. Handle snapshot creation
                self._handle_snapshot_creation(current_state)

                # 4. According to state execute appropriate handling
                self._handle_state(current_state)

                # 5. Each loop ends, handle rules and update states
                self.state_machine.process_rules_and_update_states()

                # 6. Increase turn count
                self.increment_turn_count()

                # 7. Short term wait
                time.sleep(self.main_loop_sleep_secs)

            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                # Create error snapshot
                self._create_error_snapshot(str(e), "main_loop")
                
                self.global_state.log_operation(
                    "controller", "error", {"error": f"Main loop error: {str(e)}"})
                # Error recovery: back to INIT state
                self.state_machine.switch_state(
                    ControllerState.INIT, TriggerRole.CONTROLLER, f"Error recovery from main loop: {str(e)}", TriggerCode.ERROR_RECOVERY)
                time.sleep(1)

        # Record main loop end statistics
        main_loop_duration = time.time() - main_loop_start_time
        counters = self.get_counters()
        self.global_state.log_operation(
            "controller", "main_loop_completed", {
                "duration": main_loop_duration,
                "step_count": counters["step_count"],
                "turn_count": counters["turn_count"],
                "final_state": self.state_machine.get_current_state().value
            })
        
        # Create completed snapshot
        if self.enable_snapshots:
            self._create_checkpoint_snapshot("task_completed")
        
        logger.info(
            f"Main loop completed in {main_loop_duration:.2f}s with {counters['step_count']} steps and {counters['turn_count']} turns"
        )
    
    def _handle_state(self, current_state: ControllerState):
        """Handle state according to state"""
        if current_state == ControllerState.INIT:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_init_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.GET_ACTION:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_get_action_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.EXECUTE_ACTION:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_execute_action_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.QUALITY_CHECK:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_quality_check_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.PLAN:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_plan_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.SUPPLEMENT:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_supplement_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.FINAL_CHECK:
            new_state, trigger_role, trigger_details, trigger_code = self.state_handlers.handle_final_check_state()
            self.state_machine.switch_state(new_state, trigger_role, trigger_details, trigger_code)
            
        elif current_state == ControllerState.DONE:
            logger.info("Task completed")
        else:
            logger.error(f"Unknown state: {current_state}")
            self.state_machine.switch_state(
                ControllerState.INIT, TriggerRole.CONTROLLER, f"Unknown state encountered: {current_state}", TriggerCode.UNKNOWN_STATE)
    
    def get_controller_info(self) -> Dict[str, Any]:
        """Get controller information"""
        return {
            "current_state": self.state_machine.get_current_state().value,
            "state_start_time": self.global_state.get_controller_state_start_time(),
            "state_switch_count": self.state_machine.get_state_switch_count(),
            "plan_num": self.global_state.get_plan_num(),
            "controller_state": self.global_state.get_controller_state(),
            "task_id": self.global_state.task_id,
            "executor_status": self.executor.get_execution_status(),
            "snapshot_info": {
                "enabled": self.enable_snapshots,
                "interval": self.snapshot_interval,
                "last_snapshot_step": self.last_snapshot_step,
                "checkpoint_snapshots": self.create_checkpoint_snapshots,
                "note": "Use create_manual_snapshot() to create snapshots"
            }
        }

    def reset_controller(self):
        """Reset controller state"""
        logger.info("Resetting controller")
        self.state_machine.reset_state_switch_count()
        self.global_state.reset_controller_state()
        self.reset_counters()  # Reset counters
        
        # Reset snapshot related state
        self.last_snapshot_step = 0
        
        # Reset plan_num
        task = self.global_state.get_task()
        if task:
            task.plan_num = 0
            self.global_state.set_task(task)
            logger.info("Plan number reset to 0")
        
        logger.info("Controller reset completed")

    def reset_counters(self) -> None:
        """Reset statistics counters"""
        self.step_count = 0
        self.turn_count = 0
        logger.info("Counters reset: step_count=0, turn_count=0")

    def increment_step_count(self) -> None:
        """Increment step count"""
        self.step_count += 1
        logger.debug(f"Step count incremented: {self.step_count}")

    def increment_turn_count(self) -> None:
        """Increment turn count"""
        self.turn_count += 1
        logger.debug(f"Turn count incremented: {self.turn_count}")

    def get_counters(self) -> Dict[str, int]:
        """Get current counters status"""
        task = self.global_state.get_task()
        step_count = task.step_num if task else 0
        return {"step_count": step_count, "turn_count": self.turn_count} 

    # ========= Snapshot Management Methods =========
    def create_manual_snapshot(self, description: str = "") -> Optional[str]:
        """Manual snapshot creation"""
        try:
            if not self.enable_snapshots:
                logger.warning("Snapshots are disabled")
                return None
            
            task = self.global_state.get_task()
            current_step = task.step_num if task else 0
            
            if not description:
                description = f"Manual snapshot at step {current_step}"
            
            # Prepare configuration parameters
            config_params = self._base_snapshot_config()
            
            snapshot_id = self.global_state.create_snapshot(description, "manual", config_params)
            logger.info(f"Manual snapshot created: {snapshot_id}")
            return snapshot_id
            
        except Exception as e:
            logger.error(f"Failed to create manual snapshot: {e}")
            return None

 