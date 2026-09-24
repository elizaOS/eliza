"""
Data Models for Maestro Agent System
Defines core data structure models in the system
"""

from typing import List, Optional, Dict, Any, Union
from datetime import datetime
from dataclasses import dataclass, field
from enum import Enum
import time

from .enums import (
    TaskStatus, SubtaskStatus, GateDecision, GateTrigger,
    ControllerState, ExecStatus, WorkerDecision
)

# ========= Controller State Data Model =========
@dataclass
class ControllerStateData:
    """Controller state data structure"""
    current_state: str = field(default_factory=lambda: ControllerState.GET_ACTION.value)
    trigger: str = field(default="controller")
    trigger_details: str = field(default="initialization")
    trigger_code: str = field(default="controller")
    history_state: List[str] = field(default_factory=list)
    state_start_time: float = field(default_factory=time.time)
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "current_state": self.current_state,
            "trigger": self.trigger,
            "trigger_details": self.trigger_details,
            "trigger_code": self.trigger_code,
            "history_state": self.history_state,
            "state_start_time": self.state_start_time,
            "updated_at": self.updated_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ControllerStateData':
        """Create instance from dictionary"""
        return cls(
            current_state=data.get("current_state", ControllerState.GET_ACTION.value),
            trigger=data.get("trigger", "controller"),
            trigger_details=data.get("trigger_details", "initialization"),
            trigger_code=data.get("trigger_code", "controller"),
            history_state=data.get("history_state", []),
            state_start_time=data.get("state_start_time", time.time()),
            updated_at=data.get("updated_at", datetime.now().isoformat())
        )


# ========= Task Data Model =========
@dataclass
class TaskData:
    """Task data structure"""
    task_id: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    objective: str = ""
    status: str = field(default_factory=lambda: TaskStatus.CREATED.value)
    current_subtask_id: Optional[str] = None
    step_num: int = 0
    plan_num: int = 0  # Record the number of planning attempts
    history_subtask_ids: List[str] = field(default_factory=list)
    pending_subtask_ids: List[str] = field(default_factory=list)
    managerComplete: bool = False
    qa_policy: Dict[str, Any] = field(default_factory=lambda: {
        "per_subtask": True,
        "final_gate": True,
        "risky_actions": ["open", "submit", "hotkey"]
    })

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "task_id": self.task_id,
            "created_at": self.created_at,
            "objective": self.objective,
            "status": self.status,
            "current_subtask_id": self.current_subtask_id,
            "step_num": self.step_num,
            "plan_num": self.plan_num,
            "history_subtask_ids": self.history_subtask_ids,
            "pending_subtask_ids": self.pending_subtask_ids,
            "managerComplete": self.managerComplete,
            "qa_policy": self.qa_policy
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TaskData':
        """Create instance from dictionary"""
        return cls(
            task_id=data["task_id"],
            created_at=data.get("created_at", datetime.now().isoformat()),
            objective=data.get("objective", ""),
            status=data.get("status", TaskStatus.CREATED.value),
            current_subtask_id=data.get("current_subtask_id"),
            step_num=data.get("step_num", 0),
            plan_num=data.get("plan_num", 0),
            history_subtask_ids=data.get("history_subtask_ids", []),
            pending_subtask_ids=data.get("pending_subtask_ids", []),
            managerComplete=data.get("managerComplete", False),
            qa_policy=data.get("qa_policy", {
                "per_subtask": True,
                "final_gate": True,
                "risky_actions": ["open", "submit", "hotkey"]
            })
        )


# ========= Subtask Data Model =========
@dataclass
class SubtaskData:
    """Subtask data structure"""
    subtask_id: str
    task_id: str
    title: str = ""
    description: str = ""
    assignee_role: str = "operator"
    attempt_no: int = 1
    status: str = field(default_factory=lambda: SubtaskStatus.READY.value)
    reasons_history: List[Dict[str, str]] = field(default_factory=list)
    command_trace_ids: List[str] = field(default_factory=list)
    gate_check_ids: List[str] = field(default_factory=list)
    last_reason_text: Optional[str] = None
    last_gate_decision: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "subtask_id": self.subtask_id,
            "task_id": self.task_id,
            "title": self.title,
            "description": self.description,
            "assignee_role": self.assignee_role,
            "attempt_no": self.attempt_no,
            "status": self.status,
            "reasons_history": self.reasons_history,
            "command_trace_ids": self.command_trace_ids,
            "gate_check_ids": self.gate_check_ids,
            "last_reason_text": self.last_reason_text,
            "last_gate_decision": self.last_gate_decision,
            "created_at": self.created_at,
            "updated_at": self.updated_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'SubtaskData':
        """Create instance from dictionary"""
        return cls(
            subtask_id=data["subtask_id"],
            task_id=data["task_id"],
            title=data.get("title", ""),
            description=data.get("description", ""),
            assignee_role=data.get("assignee_role", "operator"),
            attempt_no=data.get("attempt_no", 1),
            status=data.get("status", SubtaskStatus.READY.value),
            reasons_history=data.get("reasons_history", []),
            command_trace_ids=data.get("command_trace_ids", []),
            gate_check_ids=data.get("gate_check_ids", []),
            last_reason_text=data.get("last_reason_text"),
            last_gate_decision=data.get("last_gate_decision"),
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat())
        )


# ========= Command Data Model =========
@dataclass
class CommandData:
    """Command data structure"""
    command_id: str
    task_id: str
    subtask_id: Optional[str] = None
    assignee_role: str = "operator"
    action: Dict[str, Any] = field(default_factory=dict)
    pre_screenshot_id: Optional[str] = None
    pre_screenshot_analysis: str = ""
    post_screenshot_id: Optional[str] = None
    worker_decision: str = field(default_factory=lambda: WorkerDecision.GENERATE_ACTION.value)
    message: str = ""  # Worker decision message
    reason_text: str = ""  # Unified reason text across decisions
    exec_status: str = field(default_factory=lambda: ExecStatus.PENDING.value)
    exec_message: str = "OK"
    exec_latency_ms: int = 0
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    executed_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "command_id": self.command_id,
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "assignee_role": self.assignee_role,
            "action": self.action,
            "pre_screenshot_id": self.pre_screenshot_id,
            "pre_screenshot_analysis": self.pre_screenshot_analysis,
            "post_screenshot_id": self.post_screenshot_id,
            "worker_decision": self.worker_decision,
            "message": self.message,
            "reason_text": self.reason_text,
            "exec_status": self.exec_status,
            "exec_message": self.exec_message,
            "exec_latency_ms": self.exec_latency_ms,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "executed_at": self.executed_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'CommandData':
        """Create instance from dictionary"""
        return cls(
            command_id=data["command_id"],
            task_id=data["task_id"],
            subtask_id=data.get("subtask_id"),
            assignee_role=data.get("assignee_role", "operator"),
            action=data.get("action", {}),
            pre_screenshot_id=data.get("pre_screenshot_id"),
            pre_screenshot_analysis=data.get("pre_screenshot_analysis", ""),
            post_screenshot_id=data.get("post_screenshot_id"),
            worker_decision=data.get("worker_decision", WorkerDecision.GENERATE_ACTION.value),
            message=data.get("message", ""),
            reason_text=data.get("reason_text", ""),
            exec_status=data.get("exec_status", ExecStatus.PENDING.value),
            exec_message=data.get("exec_message", "OK"),
            exec_latency_ms=data.get("exec_latency_ms", 0),
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat()),
            executed_at=data.get("executed_at", datetime.now().isoformat())
        )


# ========= Gate Check Data Model =========
@dataclass
class GateCheckData:
    """Gate check data structure"""
    gate_check_id: str
    task_id: str
    subtask_id: Optional[str] = None
    trigger: str = field(default_factory=lambda: GateTrigger.PERIODIC_CHECK.value)
    decision: Optional[str] = None
    notes: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "gate_check_id": self.gate_check_id,
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "trigger": self.trigger,
            "decision": self.decision,
            "notes": self.notes,
            "created_at": self.created_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'GateCheckData':
        """Create instance from dictionary"""
        return cls(
            gate_check_id=data["gate_check_id"],
            task_id=data["task_id"],
            subtask_id=data.get("subtask_id"),
            trigger=data.get("trigger", GateTrigger.PERIODIC_CHECK.value),
            decision=data.get("decision"),
            notes=data.get("notes", ""),
            created_at=data.get("created_at", datetime.now().isoformat())
        )


# ========= Factory Functions =========
def create_task_data(task_id: str, objective: str = "") -> TaskData:
    """Create new task data"""
    return TaskData(
        task_id=task_id,
        objective=objective,
        status=TaskStatus.CREATED.value
    )


def create_subtask_data(subtask_id: str, task_id: str, title: str, description: str, 
                       assignee_role: str = "operator") -> SubtaskData:
    """Create new subtask data"""
    return SubtaskData(
        subtask_id=subtask_id,
        task_id=task_id,
        title=title,
        description=description,
        assignee_role=assignee_role,
        status=SubtaskStatus.READY.value
    )


def create_command_data(command_id: str, task_id: str, action: Dict[str, Any], 
                       subtask_id: Optional[str] = None, assignee_role: str = "") -> CommandData:
    """Create new command data"""
    return CommandData(
        command_id=command_id,
        task_id=task_id,
        subtask_id=subtask_id,
        assignee_role=assignee_role,
        action=action,
        exec_status=ExecStatus.PENDING.value
    )


def create_gate_check_data(gate_check_id: str, task_id: str, decision: str, 
                          subtask_id: Optional[str] = None, notes: str = "",
                          trigger: str = GateTrigger.PERIODIC_CHECK.value) -> GateCheckData:
    """Create new gate check data"""
    return GateCheckData(
        gate_check_id=gate_check_id,
        task_id=task_id,
        subtask_id=subtask_id,
        decision=decision,
        notes=notes,
        trigger=trigger
    )


def create_controller_state_data(state: ControllerState = ControllerState.GET_ACTION,
                               trigger: str = "controller", 
                               trigger_details: str = "initialization") -> ControllerStateData:
    """Create new controller state data"""
    return ControllerStateData(
        current_state=state.value,
        trigger=trigger,
        trigger_details=trigger_details
    )