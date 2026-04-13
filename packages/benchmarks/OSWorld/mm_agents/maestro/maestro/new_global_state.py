# new_global_state.py
import json
import os
import time
import logging
import io
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any, Union
from datetime import datetime
from enum import Enum

from PIL import Image

from ..utils.common_utils import Node
from ..utils.file_utils import (
    locked, safe_json_dump, safe_json_load,
    safe_write_json, safe_read_json, safe_write_text, safe_read_text
)
from ..utils.id_utils import generate_uuid, generate_timestamp_id

logger = logging.getLogger(__name__)

# ========= Import Enums =========
from .enums import (
    TaskStatus, SubtaskStatus, GateDecision, GateTrigger,
    ControllerState, ExecStatus, WorkerDecision
)

# ========= Import Data Models =========
from .data_models import (
    TaskData, SubtaskData, CommandData, GateCheckData, ControllerStateData,
    create_task_data, create_subtask_data, create_command_data,
    create_gate_check_data, create_controller_state_data
)

# ========= Import Simple Snapshot System =========
from .simple_snapshot import SimpleSnapshot

# ========= New GlobalState =========
class NewGlobalState:
    """Enhanced global state management for new architecture with role-based access"""

    def __init__(
        self,
        *,
        screenshot_dir: str,
        state_dir: str,
        task_id: Optional[str] = None,
        display_info_path: str = "",
    ):
        self.screenshot_dir = Path(screenshot_dir)
        self.state_dir = Path(state_dir)
        self.task_id = task_id or f"task-{generate_uuid()[:8]}"

        # State file paths
        self.task_path = self.state_dir / "task.json"
        self.subtasks_path = self.state_dir / "subtasks.json"
        self.commands_path = self.state_dir / "commands.json"
        self.gate_checks_path = self.state_dir / "gate_checks.json"
        self.artifacts_path = self.state_dir / "artifacts.md"
        self.supplement_path = self.state_dir / "supplement.md"
        self.events_path = self.state_dir / "events.json"
        self.controller_state_path = self.state_dir / "controller_state.json"

        # Legacy paths for compatibility
        self.display_info_path = Path(display_info_path) if display_info_path else self.state_dir / "display.json"

        # Initialize snapshot system
        self.snapshot_system = SimpleSnapshot(str(self.state_dir.parent))

        # Ensure necessary directories and files exist
        self._initialize_directories_and_files()

    def _initialize_directories_and_files(self):
        """Initialize directories and create default files"""
        # Create directories
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)

        # Initialize state files with default content
        self._init_task_file()
        self._init_subtasks_file()
        self._init_commands_file()
        self._init_gate_checks_file()
        self._init_artifacts_file()
        self._init_supplement_file()
        self._init_events_file()
        self._init_controller_state_file()

        # Initialize legacy files
        if not self.display_info_path.exists():
            self.display_info_path.parent.mkdir(parents=True, exist_ok=True)
            safe_write_text(self.display_info_path, "{}")

    def _init_task_file(self):
        """Initialize task.json with default content"""
        if not self.task_path.exists():
            default_task = {
                "task_id": self.task_id,
                "created_at": datetime.now().isoformat(),
                "objective": "",
                "status": TaskStatus.CREATED.value,
                "current_subtask_id": None,
                "step_num": 0,
                "plan_num": 0,
                "completed_subtasks": [],
                "pending_subtasks": [],
                # "qa_policy": {
                #     "per_subtask": True,
                #     "final_gate": True,
                #     "risky_actions": ["open", "submit", "hotkey"]
                # }
            }
            safe_write_json(self.task_path, default_task)

    def _init_subtasks_file(self):
        """Initialize subtasks.json with empty list"""
        if not self.subtasks_path.exists():
            safe_write_text(self.subtasks_path, "[]")

    def _init_commands_file(self):
        """Initialize commands.json with empty list"""
        if not self.commands_path.exists():
            safe_write_text(self.commands_path, "[]")

    def _init_gate_checks_file(self):
        """Initialize gate_checks.json with empty list"""
        if not self.gate_checks_path.exists():
            safe_write_text(self.gate_checks_path, "[]")

    def _init_artifacts_file(self):
        """Initialize artifacts.md with header"""
        if not self.artifacts_path.exists():
            default_content = ""
            safe_write_text(self.artifacts_path, default_content)

    def _init_supplement_file(self):
        """Initialize supplement.md with header"""
        if not self.supplement_path.exists():
            default_content = ""
            safe_write_text(self.supplement_path, default_content)

    def _init_events_file(self):
        """Initialize events.json with empty list"""
        if not self.events_path.exists():
            safe_write_text(self.events_path, "[]")

    def _init_controller_state_file(self):
        """Initialize controller_state.json with default content"""
        if not self.controller_state_path.exists():
            default_controller_state = {
                "current_state": ControllerState.GET_ACTION.value,
                "trigger": "controller",
                "trigger_details": "initialization",
                "history_state": [],
                "updated_at": datetime.now().isoformat()
            }
            safe_write_json(self.controller_state_path, default_controller_state)

    # ========= Utility Methods =========
    # _safe_write_json and _safe_read_json methods removed - now using safe_write_json and safe_read_json from file_utils

    def _generate_id(self, prefix: str) -> str:
        """Generate unique ID with prefix"""
        return f"{prefix}-{generate_uuid()[:4]}"

    # ========= Screenshot Management =========
    def get_screenshot(self) -> Optional[bytes]:
        """Get latest screenshot as bytes"""
        pngs = sorted(self.screenshot_dir.glob("*.png"))
        if not pngs:
            logger.warning("No screenshot found in %s", self.screenshot_dir)
            return None
        latest = pngs[-1]
        screenshot = Image.open(latest)
        buf = io.BytesIO()
        screenshot.save(buf, format="PNG")
        return buf.getvalue()

    def set_screenshot(self, img: Image.Image) -> str:
        """Save screenshot and return screenshot ID"""
        ts = int(time.time() * 1000)
        screenshot_id = f"shot-{ts:06d}"
        out = self.screenshot_dir / f"{screenshot_id}.png"
        img.save(out)
        logger.debug("Screenshot saved to %s", out)
        return screenshot_id

    def get_screenshot_id(self) -> Optional[str]:
        """Return the latest screenshot's ID (file stem) or None if none exist"""
        pngs = sorted(self.screenshot_dir.glob("*.png"))
        if not pngs:
            logger.warning("No screenshot found in %s", self.screenshot_dir)
            return None
        latest = pngs[-1]
        return latest.stem

    def get_screen_size(self) -> List[int]:
        """Get current screen size from latest screenshot"""
        pngs = sorted(self.screenshot_dir.glob("*.png"))
        if not pngs:
            logger.warning("No screenshot found, returning default size [1920, 1080]")
            return [1920, 1080]

        latest = pngs[-1]
        try:
            screenshot = Image.open(latest)
            width, height = screenshot.size
            logger.info("Current screen size: [%d, %d]", width, height)
            return [width, height]
        except Exception as e:
            logger.error("Failed to get screen size: %s", e)
            return [1920, 1080]

    # ========= Task Management =========
    def get_task(self) -> TaskData:
        """Get current task information"""
        task_dict = safe_read_json(self.task_path, {})
        return TaskData.from_dict(task_dict)

    def set_task(self, task_data: TaskData) -> None:
        """Update task information"""
        safe_write_json(self.task_path, task_data.to_dict())

    def update_task_status(self, status: TaskStatus) -> None:
        """Update task status"""
        task = self.get_task()
        task.status = status.value
        self.set_task(task)

    def set_task_objective(self, objective: str) -> None:
        """Set task objective"""
        task = self.get_task()
        task.objective = objective
        self.set_task(task)

    def set_manager_complete(self, complete: bool) -> None:
        """Set whether manager has completed planning for the whole task"""
        task = self.get_task()
        task.managerComplete = bool(complete)
        self.set_task(task)

    def set_current_subtask_id(self, subtask_id: str) -> None:
        """Set current subtask ID"""
        task = self.get_task()
        task.current_subtask_id = subtask_id
        self.set_task(task)
    
    def increment_step_num(self) -> None:
        """Increment step number"""
        task = self.get_task()
        task.step_num += 1
        self.set_task(task)

    def increment_plan_num(self) -> None:
        """Increment plan number"""
        task = self.get_task()
        task.plan_num += 1
        self.set_task(task)

    def get_plan_num(self) -> int:
        """Get current plan number"""
        task = self.get_task()
        return task.plan_num

    def advance_to_next_subtask(self) -> None:
        """
        Advance to the next subtask
        
            
        Logic:
        1. If there is a current_subtask_id, move it to history_subtask_ids
        2. Set new current_subtask_id
        3. Remove the first element from pending_subtask_ids (if exists)
        """
        task = self.get_task()

        # 1. Move current current_subtask_id to history_subtask_ids
        if task.current_subtask_id:
            if task.current_subtask_id not in task.history_subtask_ids:
                task.history_subtask_ids.append(task.current_subtask_id)

        # 2. Set new current_subtask_id to the first element of pending_subtask_ids
        task.current_subtask_id = task.pending_subtask_ids[0]

        # 3. Remove the first element from pending_subtask_ids (if exists and matches new ID)
        if task.pending_subtask_ids and task.pending_subtask_ids[0] == task.current_subtask_id:
            task.pending_subtask_ids.pop(0)

        self.set_task(task)

    def add_history_subtask(self, subtask_id: str) -> None:
        """Add subtask to completed list"""
        task = self.get_task()
        if subtask_id not in task.history_subtask_ids:
            task.history_subtask_ids.append(subtask_id)
        self.set_task(task)

    def add_pending_subtask(self, subtask_id: str) -> None:
        """Add subtask to pending list"""
        task = self.get_task()
        if subtask_id not in task.pending_subtask_ids:
            task.pending_subtask_ids.append(subtask_id)
        self.set_task(task)

    def remove_pending_subtask(self, subtask_id: str) -> None:
        """Remove subtask from pending list"""
        task = self.get_task()
        if subtask_id in task.pending_subtask_ids:
            task.pending_subtask_ids.remove(subtask_id)
        self.set_task(task)

    # ========= Subtask Management =========
    def get_subtasks(self) -> List[SubtaskData]:
        """Get all subtasks"""
        subtasks_list = safe_read_json(self.subtasks_path, [])
        return [SubtaskData.from_dict(subtask) for subtask in subtasks_list]

    def get_subtask(self, subtask_id: str) -> Optional[SubtaskData]:
        """Get specific subtask by ID"""
        subtasks = self.get_subtasks()
        for subtask in subtasks:
            if subtask.subtask_id == subtask_id:
                return subtask
        return None

    def add_subtask(self, subtask_data: SubtaskData) -> str:
        """Add new subtask and return subtask ID"""
        subtasks = self.get_subtasks()
        subtask_id = subtask_data.subtask_id or self._generate_id("subtask")
        subtask_data.subtask_id = subtask_id
        subtask_data.task_id = self.task_id
        subtask_data.attempt_no = subtask_data.attempt_no or 1
        subtask_data.status = subtask_data.status or SubtaskStatus.READY.value
        subtask_data.reasons_history = subtask_data.reasons_history or []
        subtask_data.command_trace_ids = subtask_data.command_trace_ids or []
        subtask_data.gate_check_ids = subtask_data.gate_check_ids or []

        subtasks.append(subtask_data)
        safe_write_json(self.subtasks_path, [subtask.to_dict() for subtask in subtasks])

        # Add to pending list
        self.add_pending_subtask(subtask_id)

        return subtask_id

    def delete_subtasks(self, subtask_ids: List[str]) -> None:
        """Delete subtasks by IDs and update task's pending and current pointers."""
        if not subtask_ids:
            return
        # Filter out the subtasks to be removed
        current_subtasks = self.get_subtasks()
        remaining_subtasks = [s for s in current_subtasks if s.subtask_id not in subtask_ids]
        safe_write_json(self.subtasks_path, [s.to_dict() for s in remaining_subtasks])
        # Update task lists
        task = self.get_task()
        task.pending_subtask_ids = [sid for sid in task.pending_subtask_ids if sid not in subtask_ids]
        # Defensive: also remove from completed list if present
        # task.history_subtask_ids = [sid for sid in task.history_subtask_ids if sid not in subtask_ids]
        # Clear current pointer if it was deleted
        # if task.current_subtask_id in subtask_ids:
        # task.current_subtask_id = None
        self.set_task(task)

    def update_subtask_status(self, subtask_id: str, status: SubtaskStatus, reason: Optional[str] = None) -> None:
        """Update subtask status and optionally add reason"""
        subtasks = self.get_subtasks()
        for subtask in subtasks:
            if subtask.subtask_id == subtask_id:
                subtask.status = status.value
                if reason:
                    reason_entry = {
                        "at": datetime.now().isoformat(),
                        "text": reason
                    }
                    subtask.reasons_history.append(reason_entry)
                    subtask.last_reason_text = reason
                break

        safe_write_json(self.subtasks_path, [subtask.to_dict() for subtask in subtasks])

    def add_subtask_reason(self, subtask_id: str, reason: str) -> None:
        """Add reason to subtask history"""
        subtasks = self.get_subtasks()
        for subtask in subtasks:
            if subtask.subtask_id == subtask_id:
                reason_entry = {
                    "at": datetime.now().isoformat(),
                    "text": reason
                }
                subtask.reasons_history.append(reason_entry)
                subtask.last_reason_text = reason
                break

        safe_write_json(self.subtasks_path, [subtask.to_dict() for subtask in subtasks])

    def add_subtask_command_trace(self, subtask_id: str, command_id: str) -> None:
        """Add command ID to subtask trace"""
        subtasks = self.get_subtasks()
        for subtask in subtasks:
            if subtask.subtask_id == subtask_id:
                if command_id not in subtask.command_trace_ids:
                    subtask.command_trace_ids.append(command_id)
                break

        safe_write_json(self.subtasks_path, [subtask.to_dict() for subtask in subtasks])

    def add_subtask_gate_check(self, subtask_id: str, gate_check_id: str) -> None:
        """Add gate check ID to subtask"""
        subtasks = self.get_subtasks()
        for subtask in subtasks:
            if subtask.subtask_id == subtask_id:
                if gate_check_id not in subtask.gate_check_ids:
                    subtask.gate_check_ids.append(gate_check_id)
                break

        safe_write_json(self.subtasks_path, [subtask.to_dict() for subtask in subtasks])

    def update_subtask_last_gate(self, subtask_id: str, gate_decision: GateDecision) -> None:
        """Update subtask last gate decision"""
        subtasks = self.get_subtasks()
        for subtask in subtasks:
            if subtask.subtask_id == subtask_id:
                subtask.last_gate_decision = gate_decision.value
                break

        safe_write_json(self.subtasks_path, [subtask.to_dict() for subtask in subtasks])

    # ========= Command Management =========
    def get_commands(self) -> List[CommandData]:
        """Get all commands"""
        commands_list = safe_read_json(self.commands_path, [])
        return [CommandData.from_dict(command) for command in commands_list]

    def get_commands_for_subtask(self, subtask_id: str) -> List[CommandData]:
        """Get all commands for a specific subtask, ordered by creation time"""
        try:
            # Get the subtask to find its command trace
            subtask = self.get_subtask(subtask_id)
            if not subtask or not subtask.command_trace_ids:
                return []

            # Get all commands for this subtask
            commands = []
            for command_id in subtask.command_trace_ids:
                command = self.get_command(command_id)
                if command:
                    commands.append(command)

            # Sort by creation time (newest first)
            commands.sort(key=lambda x: x.created_at, reverse=True)
            return commands
        except Exception as e:
            logger.error(f"Error getting commands for subtask {subtask_id}: {e}")
            return []

    def get_command(self, command_id: str) -> Optional[CommandData]:
        """Get specific command by ID"""
        commands = self.get_commands()
        for command in commands:
            if command.command_id == command_id:
                return command
        return None

    def get_current_command_for_subtask(self, subtask_id: str) -> Optional[CommandData]:
        """Get the latest command for a specific subtask"""
        try:
            # Get the subtask to find its command trace
            subtask = self.get_subtask(subtask_id)
            if not subtask or not subtask.command_trace_ids:
                return None

            # Get the latest command ID from the trace
            latest_command_id = subtask.command_trace_ids[-1]

            # Get the command data
            return self.get_command(latest_command_id)
        except Exception as e:
            logger.error(f"Error getting current command for subtask {subtask_id}: {e}")
            return None

    def get_latest_command_for_subtask(self, subtask_id: str) -> Optional[CommandData]:
        """Get the latest command for a specific subtask (alias for get_current_command_for_subtask)"""
        return self.get_current_command_for_subtask(subtask_id)

    def add_command(self, command_data: CommandData) -> str:
        """Add new command and return command ID"""
        commands = self.get_commands()
        command_id = command_data.command_id or self._generate_id("cmd")

        command_data.command_id = command_id
        command_data.task_id = self.task_id

        commands.append(command_data)
        safe_write_json(self.commands_path, [command.to_dict() for command in commands])

        # Add to subtask trace
        if command_data.subtask_id:
            self.add_subtask_command_trace(command_data.subtask_id, command_id)

        return command_id

    def update_command_exec_status(self, command_id: str, exec_status: ExecStatus,
                                 exec_message: str = "", exec_latency_ms: int = 0) -> None:
        """Update command execution status"""
        commands = self.get_commands()
        for command in commands:
            if command.command_id == command_id:
                command.exec_status = exec_status.value
                command.exec_message = exec_message
                command.exec_latency_ms = exec_latency_ms
                command.executed_at = datetime.now().isoformat()
                break

        safe_write_json(self.commands_path, [command.to_dict() for command in commands])

    def update_command_worker_decision(self, command_id: str, worker_decision: str) -> None:
        """Update command worker decision"""
        commands = self.get_commands()
        for command in commands:
            if command.command_id == command_id:
                command.worker_decision = worker_decision
                break

        safe_write_json(self.commands_path, [command.to_dict() for command in commands])

    def update_command_fields(self, command_id: str, **kwargs) -> None:
        """Update multiple command fields at once"""
        commands = self.get_commands()
        for command in commands:
            if command.command_id == command_id:
                for field, value in kwargs.items():
                    if hasattr(command, field):
                        setattr(command, field, value)
                command.updated_at = datetime.now().isoformat()
                break

        safe_write_json(self.commands_path, [command.to_dict() for command in commands])

    def update_command_post_screenshot(self, command_id: str, post_screenshot_id: str) -> None:
        """Update command post_screenshot_id after hardware execution"""
        commands = self.get_commands()
        for command in commands:
            if command.command_id == command_id:
                command.post_screenshot_id = post_screenshot_id
                command.updated_at = datetime.now().isoformat()
                logger.debug(f"Updated post_screenshot_id for command {command_id}: {post_screenshot_id}")
                break

        safe_write_json(self.commands_path, [command.to_dict() for command in commands])

    def get_commands_by_worker_decision(self, worker_decision: str) -> List[CommandData]:
        """Get all commands with specific worker decision"""
        commands = self.get_commands()
        return [cmd for cmd in commands if cmd.worker_decision == worker_decision]

    def get_subtask_worker_decision(self, subtask_id: str) -> Optional[str]:
        """Get the worker decision for the current command of a subtask"""
        command = self.get_current_command_for_subtask(subtask_id)
        return command.worker_decision if command else None

    # ========= Gate Check Management =========
    def get_gate_checks(self) -> List[GateCheckData]:
        """Get all gate checks"""
        gate_checks_list = safe_read_json(self.gate_checks_path, [])
        return [GateCheckData.from_dict(gate_check) for gate_check in gate_checks_list]

    def get_gate_check(self, gate_check_id: str) -> Optional[GateCheckData]:
        """Get specific gate check by ID"""
        gate_checks = self.get_gate_checks()
        for gate_check in gate_checks:
            if gate_check.gate_check_id == gate_check_id:
                return gate_check
        return None

    def get_latest_gate_check_for_subtask(
            self, subtask_id: str) -> Optional[GateCheckData]:
        """Get the latest gate check for a specific subtask"""
        gate_checks = self.get_gate_checks()
        latest_gate = None

        for gate_check in gate_checks:
            if gate_check.subtask_id == subtask_id:
                if not latest_gate or gate_check.created_at > latest_gate.created_at:
                    latest_gate = gate_check

        return latest_gate

    def add_gate_check(self, gate_check_data: GateCheckData) -> str:
        """Add new gate check and return gate check ID"""
        gate_checks = self.get_gate_checks()
        gate_check_id = gate_check_data.gate_check_id or self._generate_id("gc")

        gate_check_data.gate_check_id = gate_check_id
        gate_check_data.task_id = self.task_id

        gate_checks.append(gate_check_data)
        safe_write_json(self.gate_checks_path, [gate_check.to_dict() for gate_check in gate_checks])

        # Add to subtask if specified
        if gate_check_data.subtask_id:
            self.add_subtask_gate_check(gate_check_data.subtask_id, gate_check_id)

        return gate_check_id

    # ========= Artifacts Management =========
    def get_artifacts(self) -> str:
        """Get artifacts content"""
        return safe_read_text(self.artifacts_path)

    def set_artifacts(self, content: str) -> None:
        """Set artifacts content"""
        safe_write_text(self.artifacts_path, content)

    def add_artifact(self, artifact_type: str, artifact_data: Dict[str, Any]) -> None:
        """Add new artifact to artifacts.md"""
        current_content = self.get_artifacts()

        # Add new artifact section
        artifact_id = self._generate_id("art")
        timestamp = datetime.now().isoformat()
        
        # Check if it's structured memorize data
        if isinstance(artifact_data, dict) and "type" in artifact_data:
            artifact_type_display = artifact_data.get("type", artifact_type)
            
            if artifact_data.get("type") == "analysis_result":
                # Handle analysis result type artifact
                analysis = artifact_data.get("analysis", "")
                recommendations = artifact_data.get("recommendations", [])
                
                new_artifact = f"""
## {artifact_type_display} - {artifact_id}
- **Created**: {timestamp}
- **Type**: {artifact_type_display}
- **Analysis**: {analysis}
- **Recommendations**: {json.dumps(recommendations, indent=2, ensure_ascii=False)}

---
"""
            else:
                # Handle other types of artifacts
                new_artifact = f"""
## {artifact_type_display} - {artifact_id}
- **Created**: {timestamp}
- **Type**: {artifact_type_display}
- **Data**: {json.dumps(artifact_data, indent=2, ensure_ascii=False)}

---
"""
        else:
            # Handle regular artifact data
            new_artifact = f"""
## {artifact_type} - {artifact_id}
- **Created**: {timestamp}
- **Type**: {artifact_type}
- **Data**: {json.dumps(artifact_data, indent=2, ensure_ascii=False)}

---
"""

        updated_content = current_content + new_artifact
        self.set_artifacts(updated_content)

    def add_memorize_artifact(self, subtask_id: str, memorize_content: str) -> None:
        """Add memorized information with structured format for analyst processing
        
        Args:
            subtask_id: The subtask this memory belongs to
            memorize_content: The content to memorize, ideally in structured format
        """
        current_content = self.get_artifacts()
        
        # Generate artifact ID and timestamp
        artifact_id = self._generate_id("mem")
        timestamp = datetime.now().isoformat()
        
        # Try to parse structured memorize content
        note = ""
        guidance = ""
        
        # Parse structured memorize content if available
        if "NOTE:" in memorize_content:
            parts = memorize_content.split("NOTE:")
            if len(parts) > 1:
                note_part = parts[1]
                if "GUIDANCE:" in note_part:
                    ng_parts = note_part.split("GUIDANCE:")
                    note = ng_parts[0].strip()
                    guidance = ng_parts[1].strip()
                else:
                    note = note_part.strip()
        else:
            # Simple data memorization
            note = memorize_content.strip()
        
        # Create structured artifact
        new_artifact = f"""
## Memorized Information - {artifact_id}
- **Created**: {timestamp}
- **Type**: memorize
- **Subtask**: {subtask_id}
- **Note**: {note if note else memorize_content}
- **Guidance**: {guidance if guidance else "Use this information as needed"}

---
"""
        
        updated_content = current_content + new_artifact
        self.set_artifacts(updated_content)
        
        # Also add to events for tracking
        self.add_event("worker", "memorize_added", f"Added memorize artifact {artifact_id} for subtask {subtask_id}")

    # ========= Supplement Management =========
    def get_supplement(self) -> str:
        """Get supplement content"""
        return safe_read_text(self.supplement_path)

    def set_supplement(self, content: str) -> None:
        """Set supplement content"""
        safe_write_text(self.supplement_path, content)

    def add_supplement_entry(self, entry_type: str, description: str,
                           sla: Optional[str] = None, status: str = "open") -> None:
        """Add new supplement entry"""
        current_content = self.get_supplement()

        entry_id = self._generate_id("sup")
        timestamp = datetime.now().isoformat()

        new_entry = f"""
## {entry_type} - {entry_id}
- **Created**: {timestamp}
- **Type**: {entry_type}
- **Description**: {description}
- **SLA**: {sla or "Not specified"}
- **Status**: {status}

---
"""

        updated_content = current_content + new_entry
        self.set_supplement(updated_content)

    # ========= Events Management =========
    def get_events(self) -> List[Dict[str, Any]]:
        """Get all events"""
        return safe_read_json(self.events_path, [])

    def add_event(self, actor: str, action: str, details: Optional[str] = None) -> str:
        """Add new event"""
        events = self.get_events()
        event_id = self._generate_id("evt")

        event = {
            "event_id": event_id,
            "task_id": self.task_id,
            "actor": actor,
            "action": action,
            "details": details,
            "timestamp": datetime.now().isoformat()
        }

        events.append(event)
        safe_write_json(self.events_path, events)

        return event_id

    # ========= Role-based Access Methods =========
    # Controller methods
    def controller_get_task_state(self) -> Dict[str, Any]:
        """Controller: Get current task state for decision making"""
        task = self.get_task()
        return {
            "task": task,
            "current_subtask": self.get_subtask(task.current_subtask_id or ""),
            "pending_subtasks": task.pending_subtask_ids
        }

    def controller_switch_state(self, new_state: str) -> None:
        """Controller: Switch to new state"""
        self.add_event("controller", f"state_switch_to_{new_state}")

    # Manager methods
    def manager_get_planning_context(self) -> Dict[str, Any]:
        """Manager: Get context needed for planning"""
        return {
            "task": self.get_task(),
            "subtasks": self.get_subtasks(),
            "artifacts": self.get_artifacts(),
            "supplement": self.get_supplement()
        }

    def manager_create_subtask(self, title: str, description: str,
                             assignee_role: str = "operator") -> str:
        """Manager: Create new subtask"""
        subtask_data = create_subtask_data(
            subtask_id="",  # Will be generated by add_subtask
            task_id=self.task_id,
            title=title,
            description=description,
            assignee_role=assignee_role
        )
        subtask_id = self.add_subtask(subtask_data)
        self.add_event("manager", "create_subtask", f"Created subtask: {title}")
        return subtask_id

    # Worker methods
    def worker_get_execution_context(self, subtask_id: str) -> Dict[str, Any]:
        """Worker: Get context needed for execution"""
        subtask = self.get_subtask(subtask_id)
        if not subtask:
            return {}

        return {
            "subtask": subtask,
            "task": self.get_task(),
            "screenshot": self.get_screenshot(),
            "artifacts": self.get_artifacts()
        }

    def worker_report_result(self, subtask_id: str, result: str,
                           reason_code: Optional[str] = None) -> None:
        """Worker: Report execution result"""
        if result == "success":
            self.update_subtask_status(subtask_id, SubtaskStatus.FULFILLED)
        elif result == "CANNOT_EXECUTE":
            self.update_subtask_status(subtask_id, SubtaskStatus.REJECTED, reason_code)
        elif result == "STALE_PROGRESS":
            self.update_subtask_status(subtask_id, SubtaskStatus.STALE)
        elif result == "NEED_SUPPLEMENT":
            self.update_subtask_status(subtask_id, SubtaskStatus.PENDING, "Need supplement")

        self.add_event("worker", f"report_{result}", f"Subtask {subtask_id}: {result}")

    # Evaluator methods
    def evaluator_get_quality_context(self, subtask_id: str) -> Dict[str, Any]:
        """Evaluator: Get context needed for quality check"""
        subtask = self.get_subtask(subtask_id)
        if not subtask:
            return {}

        return {
            "subtask": subtask,
            "commands": [self.get_command(cmd_id) for cmd_id in subtask.command_trace_ids],
            "gate_checks": [self.get_gate_check(gc_id) for gc_id in subtask.gate_check_ids],
            "screenshot": self.get_screenshot()
        }

    def evaluator_make_decision(self, subtask_id: str, decision: GateDecision,
                               notes: str, trigger: GateTrigger = GateTrigger.PERIODIC_CHECK) -> str:
        """Evaluator: Make quality gate decision"""
        gate_check_data = create_gate_check_data(
            gate_check_id="",  # Will be generated by add_gate_check
            task_id=self.task_id,
            decision=decision.value,
            notes=notes,
            trigger=trigger.value,
            subtask_id=subtask_id
        )

        gate_check_id = self.add_gate_check(gate_check_data)
        self.add_event("evaluator", f"gate_{decision.value}", f"Decision: {decision.value}")

        return gate_check_id

    # Hardware methods
    def hardware_execute_command(self, subtask_id: str, action: Dict[str, Any],
                               pre_screenshot: Image.Image) -> str:
        """Hardware: Execute command and record results"""
        # Save pre-screenshot
        pre_screenshot_id = self.set_screenshot(pre_screenshot)

        # Create command entry
        command_data = CommandData(
            command_id="",  # Will be generated by add_command
            task_id=self.task_id,
            action=action,
            subtask_id=subtask_id,
            pre_screenshot_id=pre_screenshot_id,
            pre_screenshot_analysis="Pre-execution screenshot captured"
        )

        command_id = self.add_command(command_data)
        self.add_event("hardware", "execute_command", f"Executed command: {action}")

        return command_id

    def hardware_complete_command(self, command_id: str, post_screenshot: Image.Image,
                                exec_status: ExecStatus, exec_message: str = "",
                                exec_latency_ms: int = 0) -> None:
        """Hardware: Complete command execution"""
        # Save post-screenshot
        post_screenshot_id = self.set_screenshot(post_screenshot)

        # Update command with results
        commands = self.get_commands()
        for command in commands:
            if command.command_id == command_id:
                command.post_screenshot_id = post_screenshot_id
                command.exec_status = exec_status.value
                command.exec_message = exec_message
                command.exec_latency_ms = exec_latency_ms
                command.executed_at = datetime.now().isoformat()
                break

        safe_write_json(self.commands_path, [command.to_dict() for command in commands])
        self.add_event("hardware", "complete_command", f"Completed command: {exec_status.value}")

    # ========= Legacy Compatibility Methods =========
    def get_obs_for_manager(self):
        """Legacy: Get observation for manager"""
        task = self.get_task()
        return {
            "screenshot": self.get_screenshot(),
            "task": task,
            "current_subtask": self.get_subtask(task.current_subtask_id or "")
        }

    def get_obs_for_grounding(self):
        """Legacy: Get observation for grounding"""
        return {"screenshot": self.get_screenshot()}

    def get_obs_for_evaluator(self):
        """Legacy: Get observation for evaluator"""
        return {
            "screenshot": self.get_screenshot(),
            "subtasks": self.get_subtasks(),
            "commands": self.get_commands(),
            "gate_checks": self.get_gate_checks()
        }

    def log_operation(self, module: str, operation: str, data: Dict[str, Any]) -> None:
        """Legacy: Log operation (redirects to new event system)"""
        self.add_event(module, operation, str(data))

        # Also log to display_info for backward compatibility
        try:
            display_info = safe_read_json(self.display_info_path, {})
            if "operations" not in display_info:
                display_info["operations"] = {}
            if module not in display_info["operations"]:
                display_info["operations"][module] = {}

            # If module doesn't exist, initialize as list
            if not isinstance(display_info["operations"][module], list):
                display_info["operations"][module] = []

            operation_entry = {
                "operation": operation,
                "timestamp": time.time(),
                **data
            }
            display_info["operations"][module].append(operation_entry)

            safe_write_json(self.display_info_path, display_info)
        except Exception as e:
            logger.warning(f"Failed to update display_info: {e}")

    def log_llm_operation(self, module: str, operation: str, data: Dict[str, Any], 
                          str_input: Optional[str] = None, img_input: Optional[bytes] = None) -> None:
        """
        Record LLM call operations with detailed input information
        
        Args:
            module: Module name
            operation: Operation name
            data: Basic data (tokens, cost, duration, etc.)
            str_input: Input text
            img_input: Input image (bytes)
        """
        # Get current screenshot ID
        screenshot_id = self.get_screenshot_id()
        
        # Build enhanced operation record
        enhanced_data = {
            **data,
            "llm_input": {
                "text": str_input if str_input else None,
                "screenshot_id": screenshot_id if screenshot_id else None
            }
        }
        
        # Record to display.json
        self.log_operation(module, operation, enhanced_data)
        
        # Also record to event system
        self.add_event(module, f"{operation}_llm_call", 
                      f"LLM call with {len(str_input) if str_input else 0} chars text and screenshot {screenshot_id}")

    # ========= Controller State Management =========
    def get_controller_state(self) -> Dict[str, Any]:
        """Get current controller state"""
        return safe_read_json(self.controller_state_path, {})

    def set_controller_state(self, controller_state: Dict[str, Any]) -> None:
        """Update controller state"""
        safe_write_json(self.controller_state_path, controller_state)

    def get_controller_current_state(self) -> ControllerState:
        """Get current controller state"""
        controller_state = self.get_controller_state()
        if controller_state and controller_state.get("current_state"):
            try:
                return ControllerState(controller_state["current_state"])
            except ValueError:
                return ControllerState.INIT
        return ControllerState.INIT

    def set_controller_current_state(self, state: ControllerState):
        """Set current controller state"""
        controller_state = self.get_controller_state()
        if controller_state:
            controller_state["current_state"] = state.value
            controller_state["updated_at"] = datetime.now().isoformat()
            self.set_controller_state(controller_state)

    def update_controller_state(self, 
                              new_state: ControllerState,
                              trigger_role: str = "controller",
                              trigger_details: str = "",
                              trigger_code: str = "controller"):
        """Update controller current state and add to history"""
        controller_state = self.get_controller_state()

        # Add current state to history if it's different
        current_state = controller_state.get("current_state")
        if current_state and current_state != new_state.value:
            if "history_state" not in controller_state:
                controller_state["history_state"] = []
            controller_state["history_state"].append(current_state)
        
        # Update current state, trigger info, trigger_code, state start time and timestamp
        controller_state["current_state"] = new_state.value
        controller_state["trigger_role"] = trigger_role
        controller_state["trigger_details"] = trigger_details
        controller_state["trigger_code"] = trigger_code
        controller_state["state_start_time"] = time.time()
        controller_state["updated_at"] = datetime.now().isoformat()

        self.set_controller_state(controller_state)
        self.add_event("controller", "state_change", f"State changed to: {new_state.value} (trigger_role: {trigger_role}, details: {trigger_details}, trigger_code: {trigger_code})")

    def get_controller_state_enum(self) -> ControllerState:
        """Get current controller state as enum"""
        controller_state = self.get_controller_state()
        state_str = controller_state.get("current_state", ControllerState.GET_ACTION.value)
        try:
            return ControllerState(state_str)
        except ValueError:
            logger.warning(f"Invalid controller state: {state_str}, defaulting to GET_ACTION")
            return ControllerState.GET_ACTION

    def get_controller_state_start_time(self) -> float:
        """Get controller state start time"""
        controller_state = self.get_controller_state()
        return controller_state.get("state_start_time", time.time())

    def get_controller_state_history(self) -> List[str]:
        """Get controller state history"""
        controller_state = self.get_controller_state()
        return controller_state.get("history_state", [])

    def reset_controller_state(self) -> None:
        """Reset controller state to default"""
        default_controller_state = {
            "current_state": ControllerState.INIT.value,
            "trigger_role": "controller",
            "trigger_details": "reset",
            "trigger_code": "controller",
            "history_state": [],
            "state_start_time": time.time(),
            "updated_at": datetime.now().isoformat()
        }
        self.set_controller_state(default_controller_state)
        self.add_event("controller", "state_reset", "Controller state reset to default")

    # ========= Snapshot System =========
    
    def create_snapshot(self, description: str = "", snapshot_type: str = "manual", 
                       config_params: Optional[Dict[str, Any]] = None) -> str:
        """
        Create snapshot
        
        Args:
            description: Snapshot description
            snapshot_type: Snapshot type
            config_params: Key configuration parameters, including:
                - tools_dict: Tool configuration dictionary
                - platform: Platform information
                - enable_search: Search toggle
                - env_password: Environment password
                - enable_takeover: Takeover toggle
                - enable_rag: RAG toggle
                - backend: Backend type
                - max_steps: Maximum steps
        """
        return self.snapshot_system.create_snapshot(description, snapshot_type, config_params)
    
    def restore_snapshot(self, snapshot_id: str, target_runtime_dir: Optional[str] = None) -> Dict[str, Any]:
        """
        Restore snapshot
        
        Returns:
            Dictionary containing restore information and configuration parameters
        """
        return self.snapshot_system.restore_snapshot(snapshot_id, target_runtime_dir)
    
    def list_snapshots(self) -> list:
        """List all snapshots"""
        return self.snapshot_system.list_snapshots()
    
    def delete_snapshot(self, snapshot_id: str) -> bool:
        """Delete snapshot"""
        return self.snapshot_system.delete_snapshot(snapshot_id)