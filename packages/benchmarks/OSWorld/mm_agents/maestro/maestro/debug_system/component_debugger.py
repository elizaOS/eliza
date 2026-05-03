"""
Component Debugger - Support debugging core components like Worker, Evaluator, Manager, etc.
"""

from typing import Dict, Any, Optional

from pyautogui import screenshot

from ..controller.state_handlers import NewWorker, Evaluator
from ..controller.main_controller import NewManager


class ComponentDebugger:
    """Component Debugger - Support debugging various core components"""
    
    def __init__(self, snapshot_debugger):
        self.snapshot_debugger: SnapshotDebugger = snapshot_debugger
        self.current_worker = None
        self.current_evaluator = None
        self.current_manager = None
        
    def debug_worker(self, snapshot_id: str) -> Optional[NewWorker]:
        """Debug Worker component"""
        if not self.snapshot_debugger.load_snapshot(snapshot_id):
            return None
            
        try:
            worker_params = self.snapshot_debugger.get_worker_params()
            self.current_worker = NewWorker(**worker_params)
            self.current_worker.process_subtask_and_create_command()
            print(f"Worker component created, ready to debug snapshot: {snapshot_id}")
            return self.current_worker
            
        except Exception as e:
            print(f"Failed to create Worker component: {e}")
            return None
    
    def debug_evaluator(self, snapshot_id: str) -> Optional[Evaluator]:
        """Debug Evaluator component"""
        if not self.snapshot_debugger.load_snapshot(snapshot_id):
            return None
            
        try:
            evaluator_params = self.snapshot_debugger.get_evaluator_params()
            self.current_evaluator = Evaluator(**evaluator_params)
            print(f"Evaluator component created, ready to debug snapshot: {snapshot_id}")
            return self.current_evaluator
            
        except Exception as e:
            print(f"Failed to create Evaluator component: {e}")
            return None
    
    def debug_manager(self, snapshot_id: str) -> Optional[NewManager]:
        """Debug Manager component"""
        if not self.snapshot_debugger.load_snapshot(snapshot_id):
            return None
            
        try:
            screenshot = self.snapshot_debugger.global_state.get_screenshot()
            print(f"screenshot: {screenshot.__sizeof__()}")
            manager_params = self.snapshot_debugger.get_manager_params()
            self.current_manager = NewManager(**manager_params)
            self.current_manager.plan_task("replan")
            print(f"Manager component created, ready to debug snapshot: {snapshot_id}")
            return self.current_manager
            
        except Exception as e:
            print(f"Failed to create Manager component: {e}")
            return None
    
    def step_worker(self) -> bool:
        """Step execute Worker"""
        if not self.current_worker:
            print("Please create Worker component first")
            return False
            
        try:
            print("Executing Worker step debugging...")
            self.current_worker.process_subtask_and_create_command()
            print("Worker step execution completed")
            return True
            
        except Exception as e:
            print(f"Worker execution failed: {e}")
            return False
    
    def get_worker_state(self) -> Dict[str, Any]:
        """Get current Worker state"""
        if not self.current_worker:
            return {}
            
        # Here you can get state information based on the actual structure of Worker
        return {
            "worker_created": True,
            "global_state": self.snapshot_debugger.global_state.get_current_state_summary()
        }
    
    def get_evaluator_state(self) -> Dict[str, Any]:
        """Get current Evaluator state"""
        if not self.current_evaluator:
            return {}
            
        return {
            "evaluator_created": True,
            "global_state": self.snapshot_debugger.global_state.get_current_state_summary()
        }
    
    def get_manager_state(self) -> Dict[str, Any]:
        """Get current Manager state"""
        if not self.current_manager:
            return {}
            
        return {
            "manager_created": True,
            "global_state": self.snapshot_debugger.global_state.get_current_state_summary()
        }
    
    def reset_debug_session(self):
        """Reset debug session"""
        self.current_worker = None
        self.current_evaluator = None
        self.current_manager = None
        print("Debug session has been reset")