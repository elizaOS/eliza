import asyncio
import logging
import re
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from uuid import UUID, uuid4

from elizaos_plugin_planning.types import (
    ActionPlan,
    ActionStep,
    PlanExecutionResult,
    PlanningConfig,
    RetryPolicy,
)

logger = logging.getLogger(__name__)


@dataclass
class PlanState:
    status: str = "pending"
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    current_step_index: int = 0
    error: Optional[Exception] = None


@dataclass
class PlanExecution:
    state: PlanState
    working_memory: dict[str, Any]
    results: list[dict[str, Any]]
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)


class PlanningService:
    SERVICE_TYPE = "planning"
    CAPABILITY_DESCRIPTION = "Planning and action coordination"

    def __init__(self, config: Optional[PlanningConfig] = None) -> None:
        self.config = config or PlanningConfig()
        self.runtime: Optional[Any] = None
        self.active_plans: dict[UUID, ActionPlan] = {}
        self.plan_executions: dict[UUID, PlanExecution] = {}

    async def start(self, runtime: Any) -> None:
        self.runtime = runtime
        logger.info("PlanningService started successfully")

    async def stop(self) -> None:
        for execution in self.plan_executions.values():
            execution.abort_event.set()
            execution.state.status = "cancelled"

        self.plan_executions.clear()
        self.active_plans.clear()
        logger.info("PlanningService stopped")

    async def create_simple_plan(
        self,
        message: dict[str, Any],
        state: dict[str, Any],
        response_content: Optional[dict[str, Any]] = None,
    ) -> Optional[ActionPlan]:
        try:
            actions: list[str] = []
            if response_content and response_content.get("actions"):
                actions = response_content["actions"]
            else:
                text = (message.get("content", {}).get("text") or "").lower()
                if "email" in text:
                    actions = ["SEND_EMAIL"]
                elif "research" in text and ("send" in text or "summary" in text):
                    actions = ["SEARCH", "REPLY"]
                elif any(word in text for word in ["search", "find", "research"]):
                    actions = ["SEARCH"]
                elif "analyze" in text:
                    actions = ["THINK", "REPLY"]
                else:
                    actions = ["REPLY"]

            if not actions:
                return None

            plan_id = uuid4()
            step_ids: list[UUID] = []
            steps: list[ActionStep] = []

            for i, action_name in enumerate(actions):
                step_id = uuid4()
                step_ids.append(step_id)
                steps.append(
                    ActionStep(
                        id=step_id,
                        action_name=action_name,
                        parameters={
                            "message": (response_content or {}).get("text")
                            or message.get("content", {}).get("text"),
                            "thought": (response_content or {}).get("thought"),
                            "providers": (response_content or {}).get("providers", []),
                        },
                        dependencies=[step_ids[i - 1]] if i > 0 else [],
                    )
                )

            plan = ActionPlan(
                id=plan_id,
                goal=(response_content or {}).get("text")
                or f"Execute actions: {', '.join(actions)}",
                steps=steps,
                execution_model="sequential",
                status="pending",
                metadata={
                    "created_at": asyncio.get_event_loop().time(),
                    "estimated_duration": len(steps) * 5000,
                    "priority": 1,
                    "tags": ["simple", "message-handling"],
                },
            )

            self.active_plans[plan_id] = plan
            return plan
        except Exception as e:
            logger.error(f"[PlanningService] Error creating simple plan: {e}")
            return None

    async def create_comprehensive_plan(
        self,
        context: dict[str, Any],
        message: Optional[dict[str, Any]] = None,
        state: Optional[dict[str, Any]] = None,
    ) -> ActionPlan:
        goal = context.get("goal", "")
        if not goal or not goal.strip():
            raise ValueError("Planning context must have a non-empty goal")
        if not isinstance(context.get("constraints", []), list):
            raise ValueError("Planning context constraints must be a list")
        if not isinstance(context.get("available_actions", []), list):
            raise ValueError("Planning context available_actions must be a list")

        planning_prompt = self._build_planning_prompt(context, message, state)
        if self.runtime:
            planning_response = await self.runtime.use_model(
                "TEXT_LARGE",
                {
                    "prompt": planning_prompt,
                    "temperature": 0.3,
                    "max_tokens": 2000,
                },
            )
        else:
            planning_response = self._create_fallback_plan_response(context)

        parsed_plan = self._parse_planning_response(str(planning_response), context)
        enhanced_plan = await self._enhance_plan(parsed_plan, context)

        self.active_plans[enhanced_plan.id] = enhanced_plan
        return enhanced_plan

    async def execute_plan(
        self,
        plan: ActionPlan,
        message: dict[str, Any],
        callback: Optional[Callable[[dict[str, Any]], Any]] = None,
    ) -> PlanExecutionResult:
        import time

        start_time = time.time()
        working_memory: dict[str, Any] = {}
        results: list[dict[str, Any]] = []
        errors: list[Exception] = []

        execution = PlanExecution(
            state=PlanState(status="running", start_time=start_time),
            working_memory=working_memory,
            results=results,
        )
        self.plan_executions[plan.id] = execution

        try:

            if plan.execution_model == "sequential":
                await self._execute_sequential(plan, message, execution, callback)
            elif plan.execution_model == "parallel":
                await self._execute_parallel(plan, message, execution, callback)
            elif plan.execution_model == "dag":
                await self._execute_dag(plan, message, execution, callback)
            else:
                raise ValueError(f"Unsupported execution model: {plan.execution_model}")

            execution.state.status = "failed" if errors else "completed"
            execution.state.end_time = time.time()

            result = PlanExecutionResult(
                plan_id=plan.id,
                success=len(errors) == 0,
                completed_steps=len(results),
                total_steps=len(plan.steps),
                results=results,
                errors=errors if errors else None,
                duration=(time.time() - start_time) * 1000,
            )

            return result
        except Exception as e:
            logger.error(f"[PlanningService] Plan {plan.id} execution failed: {e}")
            execution.state.status = "failed"
            execution.state.end_time = time.time()
            execution.state.error = e

            return PlanExecutionResult(
                plan_id=plan.id,
                success=False,
                completed_steps=len(results),
                total_steps=len(plan.steps),
                results=results,
                errors=[e, *errors],
                duration=(time.time() - start_time) * 1000,
            )
        finally:
            del self.plan_executions[plan.id]

    async def validate_plan(self, plan: ActionPlan) -> tuple[bool, Optional[list[str]]]:
        issues: list[str] = []

        try:
            if not plan.id or not plan.goal or not plan.steps:
                issues.append("Plan missing required fields (id, goal, or steps)")

            if len(plan.steps) == 0:
                issues.append("Plan has no steps")

            for step in plan.steps:
                if not step.id or not step.action_name:
                    issues.append(f"Step missing required fields: {step}")
                    continue

                if self.runtime:
                    action = next(
                        (a for a in self.runtime.actions if a.name == step.action_name),
                        None,
                    )
                    if not action:
                        issues.append(f"Action '{step.action_name}' not found in runtime")

            step_ids = {step.id for step in plan.steps}
            for step in plan.steps:
                for dep_id in step.dependencies:
                    if dep_id not in step_ids:
                        issues.append(f"Step '{step.id}' has invalid dependency '{dep_id}'")

            if plan.execution_model == "dag":
                if self._detect_cycles(plan.steps):
                    issues.append("Plan has circular dependencies")

            return len(issues) == 0, issues if issues else None
        except Exception as e:
            logger.error(f"[PlanningService] Error validating plan: {e}")
            return False, [f"Validation error: {str(e)}"]

    async def adapt_plan(
        self,
        plan: ActionPlan,
        current_step_index: int,
        results: list[dict[str, Any]],
        error: Optional[Exception] = None,
    ) -> ActionPlan:

        adaptation_prompt = self._build_adaptation_prompt(plan, current_step_index, results, error)

        if self.runtime:
            adaptation_response = await self.runtime.use_model(
                "TEXT_LARGE",
                {
                    "prompt": adaptation_prompt,
                    "temperature": 0.4,
                    "max_tokens": 1500,
                },
            )
        else:
            adaptation_response = ""

        adapted_plan = self._parse_adaptation_response(
            str(adaptation_response), plan, current_step_index
        )

        self.active_plans[plan.id] = adapted_plan
        logger.info(f"[PlanningService] Plan {plan.id} adapted successfully")

        return adapted_plan

    async def get_plan_status(self, plan_id: UUID) -> Optional[PlanState]:
        execution = self.plan_executions.get(plan_id)
        return execution.state if execution else None

    async def cancel_plan(self, plan_id: UUID) -> bool:
        execution = self.plan_executions.get(plan_id)
        if not execution:
            return False

        execution.abort_event.set()
        execution.state.status = "cancelled"
        import time

        execution.state.end_time = time.time()
        return True

    def _build_planning_prompt(
        self,
        context: dict[str, Any],
        message: Optional[dict[str, Any]],
        state: Optional[dict[str, Any]],
    ) -> str:
        available_actions = ", ".join(context.get("available_actions", []))
        available_providers = ", ".join(context.get("available_providers", []))
        constraints = ", ".join(
            f"{c.get('type', 'custom')}: {c.get('description', c.get('value', ''))}"
            for c in context.get("constraints", [])
        )

        preferences = context.get("preferences", {})
        execution_model = preferences.get("execution_model", "sequential")
        max_steps = preferences.get("max_steps", 10)

        message_text = ""
        if message:
            message_text = f"CONTEXT MESSAGE: {message.get('content', {}).get('text', '')}"

        state_text = ""
        if state:
            state_text = f"CURRENT STATE: {json.dumps(state.get('values', {}))}"

        return f"""You are an expert AI planning system. Create a comprehensive action plan to achieve the following goal.

GOAL: {context["goal"]}

AVAILABLE ACTIONS: {available_actions}
AVAILABLE PROVIDERS: {available_providers}
CONSTRAINTS: {constraints}

EXECUTION MODEL: {execution_model}
MAX STEPS: {max_steps}

{message_text}
{state_text}

Create a detailed plan with the following structure:
<plan>
<goal>{context["goal"]}</goal>
<execution_model>{execution_model}</execution_model>
<steps>
<step>
<id>step_1</id>
<action>ACTION_NAME</action>
<parameters>{{"key": "value"}}</parameters>
<dependencies>[]</dependencies>
<description>What this step accomplishes</description>
</step>
</steps>
<estimated_duration>Total estimated time in milliseconds</estimated_duration>
</plan>

Focus on:
1. Breaking down the goal into logical, executable steps
2. Ensuring each step uses available actions
3. Managing dependencies between steps
4. Providing realistic time estimates
5. Including error handling considerations"""

    def _parse_planning_response(self, response: str, context: dict[str, Any]) -> ActionPlan:
        try:
            plan_id = uuid4()
            steps: list[ActionStep] = []

            goal = context["goal"]
            preferences = context.get("preferences", {})
            execution_model = preferences.get("execution_model", "sequential")

            step_pattern = re.compile(r"<step>(.*?)</step>", re.DOTALL)
            step_matches = step_pattern.findall(response)

            step_id_map: dict[str, UUID] = {}

            for step_match in step_matches:
                try:
                    id_match = re.search(r"<id>(.*?)</id>", step_match)
                    action_match = re.search(r"<action>(.*?)</action>", step_match)
                    params_match = re.search(r"<parameters>(.*?)</parameters>", step_match)
                    deps_match = re.search(r"<dependencies>(.*?)</dependencies>", step_match)

                    if action_match and id_match:
                        original_id = id_match.group(1).strip()
                        actual_id = uuid4()
                        step_id_map[original_id] = actual_id

                        dependency_strings: list[str] = []
                        if deps_match:
                            try:
                                dep_array = json.loads(deps_match.group(1))
                                dependency_strings = [d for d in dep_array if d and d.strip()]
                            except json.JSONDecodeError:
                                pass

                        parameters: dict[str, Any] = {}
                        if params_match:
                            try:
                                parameters = json.loads(params_match.group(1))
                            except json.JSONDecodeError:
                                pass

                        steps.append(
                            ActionStep(
                                id=actual_id,
                                action_name=action_match.group(1).strip(),
                        parameters=parameters,
                        dependencies=[],
                    )
                        )
                        setattr(steps[-1], "_dependency_strings", dependency_strings)
                except Exception:
                    pass

            # Resolve dependencies
            for step in steps:
                dep_strings = getattr(step, "_dependency_strings", [])
                resolved_deps: list[UUID] = []
                for dep_string in dep_strings:
                    resolved_id = step_id_map.get(dep_string)
                    if resolved_id:
                        resolved_deps.append(resolved_id)
                step.dependencies = resolved_deps
                delattr(step, "_dependency_strings") if hasattr(
                    step, "_dependency_strings"
                ) else None

            if not steps:
                steps.append(
                    ActionStep(
                        id=uuid4(),
                        action_name="ANALYZE_INPUT",
                        parameters={"goal": goal},
                        dependencies=[],
                    )
                )

                if "plan" in goal.lower() or "strategy" in goal.lower():
                    steps.append(
                        ActionStep(
                            id=uuid4(),
                            action_name="PROCESS_ANALYSIS",
                            parameters={"type": "strategic_planning"},
                            dependencies=[steps[0].id],
                        )
                    )
                    steps.append(
                        ActionStep(
                            id=uuid4(),
                            action_name="EXECUTE_FINAL",
                            parameters={"deliverable": "strategy_document"},
                            dependencies=[steps[1].id],
                        )
                    )

            return ActionPlan(
                id=plan_id,
                goal=goal,
                steps=steps,
                execution_model=execution_model,
                status="pending",
                metadata={
                    "created_at": asyncio.get_event_loop().time(),
                    "priority": 1,
                    "tags": ["comprehensive"],
                },
            )
        except Exception as e:
            logger.error(f"Failed to parse planning response: {e}")
            plan_id = uuid4()
            return ActionPlan(
                id=plan_id,
                goal=context["goal"],
                steps=[
                    ActionStep(
                        id=uuid4(),
                        action_name="REPLY",
                        parameters={"text": "I will help you with this request step by step."},
                        dependencies=[],
                    )
                ],
                execution_model="sequential",
                status="pending",
                metadata={"tags": ["fallback"]},
            )

    async def _enhance_plan(self, plan: ActionPlan, context: dict[str, Any]) -> ActionPlan:
        if self.runtime:
            for step in plan.steps:
                action = next(
                    (a for a in self.runtime.actions if a.name == step.action_name),
                    None,
                )
                if not action:
                    step.action_name = "REPLY"
                    step.parameters = {"text": f"Unable to find action: {step.action_name}"}

        for step in plan.steps:
            if not step.retry_policy:
                step.retry_policy = RetryPolicy()

        return plan

    async def _execute_sequential(
        self,
        plan: ActionPlan,
        message: dict[str, Any],
        execution: PlanExecution,
        callback: Optional[Callable[[dict[str, Any]], Any]],
    ) -> None:
        for i, step in enumerate(plan.steps):
            if execution.abort_event.is_set():
                raise asyncio.CancelledError("Plan execution aborted")

            try:
                result = await self._execute_step(step, message, execution, callback)
                execution.results.append(result)
                execution.state.current_step_index = i + 1
            except Exception:
                if step.on_error == "abort" or (
                    step.retry_policy and step.retry_policy.on_error == "abort"
                ):
                    raise

    async def _execute_parallel(
        self,
        plan: ActionPlan,
        message: dict[str, Any],
        execution: PlanExecution,
        callback: Optional[Callable[[dict[str, Any]], Any]],
    ) -> None:
        tasks = [self._execute_step(step, message, execution, callback) for step in plan.steps]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for result in results:
            if not isinstance(result, Exception):
                execution.results.append(result)

    async def _execute_dag(
        self,
        plan: ActionPlan,
        message: dict[str, Any],
        execution: PlanExecution,
        callback: Optional[Callable[[dict[str, Any]], Any]],
    ) -> None:
        completed: set[UUID] = set()
        pending = {step.id for step in plan.steps}

        while pending and not execution.abort_event.is_set():
            ready_steps = [
                step
                for step in plan.steps
                if step.id in pending and all(dep_id in completed for dep_id in step.dependencies)
            ]

            if not ready_steps:
                raise ValueError("No steps ready to execute - possible circular dependency")

            tasks = [self._execute_step(step, message, execution, callback) for step in ready_steps]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for step, result in zip(ready_steps, results):
                pending.discard(step.id)
                completed.add(step.id)

                if not isinstance(result, Exception):
                    execution.results.append(result)

    async def _execute_step(
        self,
        step: ActionStep,
        message: dict[str, Any],
        execution: PlanExecution,
        callback: Optional[Callable[[dict[str, Any]], Any]],
    ) -> dict[str, Any]:
        if not self.runtime:
            return {
                "step_id": str(step.id),
                "action_name": step.action_name,
                "executed_at": asyncio.get_event_loop().time(),
                "text": f"Executed {step.action_name}",
            }

        action = next(
            (a for a in self.runtime.actions if a.name == step.action_name),
            None,
        )
        if not action:
            raise ValueError(f"Action '{step.action_name}' not found")

        retries = 0
        max_retries = step.retry_policy.max_retries if step.retry_policy else 0

        while retries <= max_retries:
            try:
                result = await action.handler(
                    self.runtime,
                    message,
                    {"values": {}, "data": {}, "text": ""},
                    {
                        **step.parameters,
                        "previous_results": execution.results,
                        "working_memory": execution.working_memory,
                    },
                    callback,
                )

                action_result = result if isinstance(result, dict) else {"text": str(result)}
                action_result["step_id"] = str(step.id)
                action_result["action_name"] = step.action_name
                action_result["executed_at"] = asyncio.get_event_loop().time()

                return action_result
            except Exception as e:
                retries += 1
                if retries > max_retries:
                    raise e

                backoff_ms = (step.retry_policy.backoff_ms if step.retry_policy else 1000) * (
                    (step.retry_policy.backoff_multiplier if step.retry_policy else 2)
                    ** (retries - 1)
                )
                await asyncio.sleep(backoff_ms / 1000)

        raise ValueError("Maximum retries exceeded")

    def _detect_cycles(self, steps: list[ActionStep]) -> bool:
        visited: set[UUID] = set()
        recursion_stack: set[UUID] = set()

        def dfs(step_id: UUID) -> bool:
            if step_id in recursion_stack:
                return True
            if step_id in visited:
                return False

            visited.add(step_id)
            recursion_stack.add(step_id)

            step = next((s for s in steps if s.id == step_id), None)
            if step:
                for dep_id in step.dependencies:
                    if dfs(dep_id):
                        return True

            recursion_stack.discard(step_id)
            return False

        for step in steps:
            if dfs(step.id):
                return True

        return False

    def _build_adaptation_prompt(
        self,
        plan: ActionPlan,
        current_step_index: int,
        results: list[dict[str, Any]],
        error: Optional[Exception],
    ) -> str:
        return f"""You are an expert AI adaptation system. A plan execution has encountered an issue and needs adaptation.

ORIGINAL PLAN: {json.dumps({"id": str(plan.id), "goal": plan.goal, "steps": [{"id": str(s.id), "action_name": s.action_name} for s in plan.steps]}, indent=2)}
CURRENT STEP INDEX: {current_step_index}
COMPLETED RESULTS: {json.dumps(results, indent=2)}
{f"ERROR: {str(error)}" if error else ""}

Analyze the situation and provide an adapted plan that:
1. Addresses the current issue
2. Maintains the original goal
3. Uses available actions effectively
4. Considers what has already been completed

Return the adapted plan in the same XML format as the original planning response."""

    def _parse_adaptation_response(
        self, response: str, original_plan: ActionPlan, current_step_index: int
    ) -> ActionPlan:
        try:
            adapted_steps: list[ActionStep] = []
            step_pattern = re.compile(r"<step>(.*?)</step>", re.DOTALL)
            step_matches = step_pattern.findall(response)
            step_id_map: dict[str, UUID] = {}

            for step_match in step_matches:
                try:
                    id_match = re.search(r"<id>(.*?)</id>", step_match)
                    action_match = re.search(r"<action>(.*?)</action>", step_match)
                    params_match = re.search(r"<parameters>(.*?)</parameters>", step_match)

                    if action_match and id_match:
                        original_id = id_match.group(1).strip()
                        actual_id = uuid4()
                        step_id_map[original_id] = actual_id

                        parameters: dict[str, Any] = {}
                        if params_match:
                            try:
                                parameters = json.loads(params_match.group(1))
                            except json.JSONDecodeError:
                                pass

                        adapted_steps.append(
                            ActionStep(
                                id=actual_id,
                                action_name=action_match.group(1).strip(),
                                parameters=parameters,
                                dependencies=[],
                            )
                        )
                except Exception:
                    pass

            if not adapted_steps:
                adapted_steps.append(
                    ActionStep(
                        id=uuid4(),
                        action_name="REPLY",
                        parameters={"text": "Plan adaptation completed successfully"},
                        dependencies=[],
                    )
                )

            return ActionPlan(
                id=uuid4(),
                goal=original_plan.goal,
                steps=original_plan.steps[:current_step_index] + adapted_steps,
                execution_model=original_plan.execution_model,
                status="pending",
                metadata={
                    **original_plan.metadata,
                    "adaptations": original_plan.metadata.get("adaptations", [])
                    + [f"Adapted at step {current_step_index}"],
                },
            )
        except Exception:
            return ActionPlan(
                id=uuid4(),
                goal=original_plan.goal,
                steps=original_plan.steps[:current_step_index]
                + [
                    ActionStep(
                        id=uuid4(),
                        action_name="REPLY",
                        parameters={"text": "Plan adaptation completed successfully"},
                        dependencies=[],
                    )
                ],
                execution_model=original_plan.execution_model,
                status="pending",
                metadata={
                    **original_plan.metadata,
                    "adaptations": original_plan.metadata.get("adaptations", [])
                    + ["Emergency fallback adaptation"],
                },
            )

    def _create_fallback_plan_response(self, context: dict[str, Any]) -> str:
        return f"""<plan>
<goal>{context["goal"]}</goal>
<execution_model>sequential</execution_model>
<steps>
<step>
<id>step_1</id>
<action>ANALYZE_INPUT</action>
<parameters>{{"goal": "{context["goal"]}"}}</parameters>
<dependencies>[]</dependencies>
</step>
</steps>
<estimated_duration>30000</estimated_duration>
</plan>"""
