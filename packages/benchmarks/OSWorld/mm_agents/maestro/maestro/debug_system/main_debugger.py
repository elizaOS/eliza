"""
Main Debugger - Integrate snapshot debugging and component debugging functionality
"""
import os
import shutil
import json
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any

from ..snapshot_restorer import restore_snapshot_and_create_globalstate
from .component_debugger import ComponentDebugger
from ..controller.state_handlers import NewWorker, Evaluator
from ..controller.main_controller import NewManager


class MainDebugger:
    """Main Debugger - Provide complete debugging functionality"""
    
    def __init__(
        self, 
        runtime_path: str = "runtime/20250826_141730", 
        snapshot_id: str = "snapshot_20250826_141736",
        target_dir: Optional[str] = None,
    ):
        target_runtime = ''
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        runtime_dir = Path(runtime_path)
        target_runtime = runtime_dir.parent / f"{runtime_dir.name}_restored_from_{snapshot_id}_{timestamp}"
        self.snapshot_id=snapshot_id
        self.global_state, self.target_path, self.config_params = restore_snapshot_and_create_globalstate(
        runtime_dir=runtime_path,
        snapshot_id=snapshot_id,
        target_dir=str(target_runtime),
    )

    def get_worker_params(self) -> Dict[str, Any]:
        """Get Worker parameters"""

        config_params = self.config_params
        
        # Extract Worker required parameters from snapshot
        worker_params = {
            "tools_dict": config_params.get('tools_dict', {}),
            "global_state": self.global_state,
            "platform": config_params.get('platform', 'default'),
            "enable_search": config_params.get('enable_search', True),
            "client_password": config_params.get('client_password', 'osworld-public-evaluation')
        }
        
        return worker_params

    def get_evaluator_params(self) -> Dict[str, Any]:
        """Get Evaluator parameters"""
        config_params = self.config_params
        return {
            "global_state": self.global_state,
            "tools_dict": config_params.get('tools_dict', {}),
        }

    def get_manager_params(self) -> Dict[str, Any]:
        """Get Manager parameters"""
        config_params = self.config_params
        return {
            "tools_dict": config_params.get('tools_dict', {}),
            "global_state": self.global_state,
            "local_kb_path": config_params.get('local_kb_path', ''),
            "platform": config_params.get('platform', 'default'),
            "enable_search": config_params.get('enable_search', True),
        }

    # === Minimal interface: create and execute directly ===
    def debug_worker(self):
        worker_params = self.get_worker_params()
        current_worker = NewWorker(**worker_params)
        current_worker.process_subtask_and_create_command()
        print(f"Worker component created, ready to debug snapshot: {self.snapshot_id}")
    
    def debug_evaluator(self):
        evaluator_params = self.get_evaluator_params()
        current_evaluator = Evaluator(**evaluator_params)
        print(f"Evaluator component created, ready to debug snapshot: {self.snapshot_id}")
        return current_evaluator
    
    def debug_manager(self):
        manager_params = self.get_manager_params()
        current_manager = NewManager(**manager_params)
        current_manager.plan_task("replan")
        print(f"Manager component created, ready to debug snapshot: {self.snapshot_id}")
        return current_manager
    
 
def create_debugger(snapshot_id: str = "snapshot_20250826_141736", runtime_path: str = "runtime/20250826_141730") -> MainDebugger:
    """Compatible with old interface: create MainDebugger instance with old parameter names
    - snapshot_dir: compatible old name, actually snapshot_id
    - state_dir: compatible old name, actually runtime_path
    """
    return MainDebugger(runtime_path=runtime_path, snapshot_id=snapshot_id)
    