from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from google.protobuf.json_format import MessageToDict

from elizaos.logger import Logger
from elizaos.types.components import ActionContext, ActionResult, HandlerCallback, HandlerOptions
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content
from elizaos.types.service import Service
from elizaos.types.state import State


@dataclass
class RetryPolicy:
    max_retries: int = 2
    backoff_ms: int = 1000
    backoff_multiplier: int = 2
    on_error: str = "abort"  # abort | continue | skip


@dataclass
class ActionStep:
    id: UUID
    action_name: str
    parameters: dict[str, object]
    dependencies: list[UUID]
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)
    on_error: str | None = None


@dataclass
class PlanState:
    status: str = "pending"  # pending | running | completed | failed | cancelled
    start_time: float | None = None
    end_time: float | None = None
    current_step_index: int = 0
    error: str | None = None


@dataclass
class ActionPlan:
    id: UUID
    goal: str
    thought: str
    total_steps: int
    current_step: int
    steps: list[ActionStep]
    execution_model: str = "sequential"
    state: PlanState = field(default_factory=PlanState)
    metadata: dict[str, object] | None = None


@dataclass
class PlanExecutionResult:
    plan_id: UUID
    success: bool
    completed_steps: int
    total_steps: int
    results: list[ActionResult]
    errors: list[str] | None = None
    duration_ms: float | None = None


@dataclass
class PlanExecution:
    state: PlanState
    working_memory: dict[str, object]
    results: list[ActionResult]
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)


class PlanningService(Service):
    service_type = "planning"

    def __init__(self, runtime=None) -> None:
        super().__init__(runtime=runtime)
        self._active_plans: dict[UUID, ActionPlan] = {}
        self._executions: dict[UUID, PlanExecution] = {}

    @property
    def capability_description(self) -> str:
        return "Planning and action coordination"

    @classmethod
    async def start(cls, runtime):
        service = cls(runtime=runtime)
        runtime.logger.info("PlanningService started successfully", src="service:planning")
        return service

    async def stop(self) -> None:
        for execution in self._executions.values():
            execution.abort_event.set()
            execution.state.status = "cancelled"
            execution.state.end_time = time.time()
        self._active_plans.clear()
        self._executions.clear()

    async def create_simple_plan(
        self,
        message: Memory,
        state: State | None = None,
        response_content: Content | None = None,
    ) -> ActionPlan | None:
        _ = state

        text = (message.content.text or "").lower()
        actions: list[str]
        if response_content and response_content.actions:
            actions = [a for a in response_content.actions if isinstance(a, str)]
        elif "email" in text:
            actions = ["SEND_EMAIL"]
        elif "research" in text and ("send" in text or "summary" in text):
            actions = ["SEARCH", "REPLY"]
        elif any(word in text for word in ["search", "find", "research"]):
            actions = ["SEARCH"]
        elif "analyze" in text:
            actions = ["THINK", "REPLY"]
        else:
            actions = ["REPLY"]

        plan_id = uuid4()
        steps: list[ActionStep] = []
        prev: UUID | None = None
        for action_name in actions:
            step_id = uuid4()
            deps = [prev] if prev else []
            steps.append(
                ActionStep(
                    id=step_id,
                    action_name=action_name,
                    parameters={
                        "message": response_content.text
                        if response_content
                        else (message.content.text or ""),
                        "thought": response_content.thought if response_content else None,
                        "providers": response_content.providers if response_content else [],
                    },
                    dependencies=[d for d in deps if d is not None],
                )
            )
            prev = step_id

        plan = ActionPlan(
            id=plan_id,
            goal=response_content.text
            if response_content and response_content.text
            else (message.content.text or "Execute plan"),
            thought=response_content.thought
            if response_content and response_content.thought
            else f"Executing {len(steps)} action(s)",
            total_steps=len(steps),
            current_step=0,
            steps=steps,
            execution_model="sequential",
            state=PlanState(status="pending"),
            metadata={"createdAt": int(time.time() * 1000)},
        )
        self._active_plans[plan_id] = plan
        return plan

    def _build_planning_prompt(
        self,
        context: dict[str, object],
        message: Memory | None,
        state: State | None,
    ) -> str:
        goal = str(context.get("goal") or "")
        available_actions = (
            context.get("available_actions") or context.get("availableActions") or []
        )
        available_providers = (
            context.get("available_providers") or context.get("availableProviders") or []
        )
        constraints_obj = context.get("constraints") or []
        preferences = (
            context.get("preferences") if isinstance(context.get("preferences"), dict) else {}
        )

        execution_model = "sequential"
        max_steps = 10
        if isinstance(preferences, dict):
            execution_model = str(
                preferences.get("execution_model")
                or preferences.get("executionModel")
                or "sequential"
            )
            max_steps = int(preferences.get("max_steps") or preferences.get("maxSteps") or 10)

        if isinstance(available_actions, list):
            actions_text = ", ".join(str(a) for a in available_actions)
        else:
            actions_text = ""

        providers_text = (
            ", ".join(str(p) for p in available_providers)
            if isinstance(available_providers, list)
            else ""
        )
        constraints_text = ""
        if isinstance(constraints_obj, list):
            parts: list[str] = []
            for c in constraints_obj:
                if isinstance(c, dict):
                    c_type = str(c.get("type") or "custom")
                    c_desc = c.get("description")
                    c_val = c.get("value")
                    parts.append(f"{c_type}: {c_desc or c_val}")
            constraints_text = ", ".join(parts)

        msg_text = (
            f"CONTEXT MESSAGE: {message.content.text}" if message and message.content.text else ""
        )
        state_text = f"CURRENT STATE: {json.dumps(state.values)}" if state else ""

        return f"""You are an expert AI planning system. Create a comprehensive action plan to achieve the following goal.

GOAL: {goal}

AVAILABLE ACTIONS: {actions_text}
AVAILABLE PROVIDERS: {providers_text}
CONSTRAINTS: {constraints_text}

EXECUTION MODEL: {execution_model}
MAX STEPS: {max_steps}

{msg_text}
{state_text}

Create a detailed plan with the following structure:
<plan>
<goal>{goal}</goal>
<execution_model>{execution_model}</execution_model>
<steps>
<step>
<id>step_1</id>
<action>ACTION_NAME</action>
<parameters>{{"key": "value"}}</parameters>
<dependencies>[]</dependencies>
</step>
</steps>
</plan>

Focus on:
1. Breaking down the goal into logical, executable steps
2. Ensuring each step uses available actions
3. Managing dependencies between steps
4. Providing realistic time estimates
5. Including error handling considerations"""

    def _parse_plan(self, response: str, goal: str) -> ActionPlan:
        plan_id = uuid4()
        steps: list[ActionStep] = []
        step_id_map: dict[str, UUID] = {}

        step_matches = re.findall(r"<step>(.*?)</step>", response, flags=re.DOTALL)
        for step_match in step_matches:
            id_match = re.search(r"<id>(.*?)</id>", step_match)
            action_match = re.search(r"<action>(.*?)</action>", step_match)
            params_match = re.search(r"<parameters>(.*?)</parameters>", step_match)
            deps_match = re.search(r"<dependencies>(.*?)</dependencies>", step_match)
            if not id_match or not action_match:
                continue

            orig_id = id_match.group(1).strip()
            actual_id = uuid4()
            step_id_map[orig_id] = actual_id

            parameters: dict[str, object] = {}
            if params_match:
                try:
                    parsed = json.loads(params_match.group(1))
                    if isinstance(parsed, dict):
                        parameters = parsed
                except Exception:
                    parameters = {}

            dep_strings: list[str] = []
            if deps_match:
                try:
                    parsed_deps = json.loads(deps_match.group(1))
                    if isinstance(parsed_deps, list):
                        dep_strings = [str(d).strip() for d in parsed_deps if str(d).strip()]
                except Exception:
                    dep_strings = []

            steps.append(
                ActionStep(
                    id=actual_id,
                    action_name=action_match.group(1).strip(),
                    parameters=parameters,
                    dependencies=[],
                )
            )
            # stash original dependency strings on the parameters dict (private key)
            steps[-1].parameters["_depStrings"] = dep_strings

        # resolve dependencies
        for step in steps:
            dep_strings_raw = step.parameters.pop("_depStrings", [])
            step_dep_strings: list[str] = []
            if isinstance(dep_strings_raw, list):
                step_dep_strings = [str(d).strip() for d in dep_strings_raw if str(d).strip()]
            deps: list[UUID] = []
            for d in step_dep_strings:
                if d in step_id_map:
                    deps.append(step_id_map[d])
            step.dependencies = deps

        if not steps:
            steps = [
                ActionStep(
                    id=uuid4(),
                    action_name="REPLY",
                    parameters={"text": "I will help you with this request step by step."},
                    dependencies=[],
                )
            ]

        plan = ActionPlan(
            id=plan_id,
            goal=goal,
            thought=f"Plan to achieve: {goal}",
            total_steps=len(steps),
            current_step=0,
            steps=steps,
            execution_model="sequential",
            state=PlanState(status="pending"),
            metadata={"createdAt": int(time.time() * 1000)},
        )
        self._active_plans[plan_id] = plan
        return plan

    def _normalize_action_name(self, name: str) -> str:
        return re.sub(r"[_\s]+", "", name.strip()).lower()

    def _build_action_lookup(self) -> dict[str, object]:
        lookup: dict[str, object] = {}
        for action in self.runtime.actions:
            name_norm = self._normalize_action_name(action.name)
            lookup.setdefault(name_norm, action)
            if action.similes:
                for s in action.similes:
                    simile_norm = self._normalize_action_name(s)
                    lookup.setdefault(simile_norm, action)
        return lookup

    def _find_action(self, action_name: str, action_lookup: dict[str, object] | None = None):
        target_norm = self._normalize_action_name(action_name)
        if action_lookup is not None:
            return action_lookup.get(target_norm)

        for action in self.runtime.actions:
            name_norm = self._normalize_action_name(action.name)
            if name_norm == target_norm:
                return action
            if action.similes:
                for s in action.similes:
                    if self._normalize_action_name(s) == target_norm:
                        return action
        return None

    async def create_comprehensive_plan(
        self,
        context: dict[str, object],
        message: Memory | None = None,
        state: State | None = None,
    ) -> ActionPlan:
        goal = str(context.get("goal") or "")
        if not goal.strip():
            raise ValueError("Planning context must have a non-empty goal")

        prompt = self._build_planning_prompt(context, message, state)
        action_lookup = self._build_action_lookup()
        try:
            response = await self.runtime.use_model(
                "TEXT_LARGE",
                {"prompt": prompt, "temperature": 0.3, "maxTokens": 2000},
            )
            plan = self._parse_plan(str(response), goal=goal)
            # enhance plan by downgrading unknown actions to REPLY
            for step in plan.steps:
                if not self._find_action(step.action_name, action_lookup):
                    missing = step.action_name
                    step.action_name = "REPLY"
                    step.parameters = {"text": f"Unable to find action: {missing}"}
            return plan
        except Exception as e:
            logger: Logger = self.runtime.logger
            logger.error(f"Failed to create comprehensive plan: {e}", src="service:planning")
            return self._parse_plan("", goal=goal)

    async def validate_plan(self, plan: ActionPlan) -> tuple[bool, list[str], list[str]]:
        errors: list[str] = []
        warnings: list[str] = []

        if not plan.goal or not plan.steps:
            errors.append("Plan missing required fields (goal or steps)")
        if len(plan.steps) == 0:
            errors.append("Plan has no steps")

        step_ids = {s.id for s in plan.steps}
        action_lookup = self._build_action_lookup()
        for step in plan.steps:
            if not step.action_name:
                errors.append(f"Step {step.id} missing action_name")
                continue
            if self._find_action(step.action_name, action_lookup) is None:
                errors.append(f"Action '{step.action_name}' not found in runtime")
            for dep in step.dependencies:
                if dep not in step_ids:
                    errors.append(f"Step '{step.id}' has invalid dependency '{dep}'")

        if plan.execution_model == "dag":
            if self._detect_cycles(plan.steps):
                errors.append("Plan has circular dependencies")

        return (len(errors) == 0, errors, warnings)

    def _detect_cycles(self, steps: list[ActionStep]) -> bool:
        visited: set[UUID] = set()
        stack: set[UUID] = set()

        by_id = {s.id: s for s in steps}

        def dfs(step_id: UUID) -> bool:
            if step_id in stack:
                return True
            if step_id in visited:
                return False
            visited.add(step_id)
            stack.add(step_id)
            step = by_id.get(step_id)
            if step:
                for dep in step.dependencies:
                    if dfs(dep):
                        return True
            stack.discard(step_id)
            return False

        return any(dfs(s.id) for s in steps)

    async def execute_plan(
        self,
        plan: ActionPlan,
        message: Memory,
        state: State | None = None,
        callback: HandlerCallback | None = None,
    ) -> PlanExecutionResult:
        start = time.time()
        working_memory: dict[str, object] = {}
        results: list[ActionResult] = []
        errors: list[str] = []

        execution_state = PlanState(status="running", start_time=start, current_step_index=0)
        execution = PlanExecution(
            state=execution_state, working_memory=working_memory, results=results
        )
        action_lookup = self._build_action_lookup()
        self._executions[plan.id] = execution

        try:
            if plan.execution_model == "parallel":
                await self._execute_parallel(
                    plan, message, state, callback, execution, action_lookup
                )
            elif plan.execution_model == "dag":
                await self._execute_dag(plan, message, state, callback, execution, action_lookup)
            else:
                await self._execute_sequential(
                    plan, message, state, callback, execution, action_lookup
                )

            execution_state.status = "failed" if errors else "completed"
            execution_state.end_time = time.time()
            return PlanExecutionResult(
                plan_id=plan.id,
                success=len(errors) == 0,
                completed_steps=len(results),
                total_steps=len(plan.steps),
                results=results,
                errors=errors if errors else None,
                duration_ms=(time.time() - start) * 1000,
            )
        except Exception as e:
            execution_state.status = "failed"
            execution_state.end_time = time.time()
            execution_state.error = str(e)
            return PlanExecutionResult(
                plan_id=plan.id,
                success=False,
                completed_steps=len(results),
                total_steps=len(plan.steps),
                results=results,
                errors=[str(e), *errors],
                duration_ms=(time.time() - start) * 1000,
            )
        finally:
            self._executions.pop(plan.id, None)

    async def _execute_sequential(
        self,
        plan: ActionPlan,
        message: Memory,
        state: State | None,
        callback: HandlerCallback | None,
        execution: PlanExecution,
        action_lookup: dict[str, object],
    ) -> None:
        for i, step in enumerate(plan.steps):
            if execution.abort_event.is_set():
                raise RuntimeError("Plan execution aborted")
            result = await self._execute_step(
                step, message, state, callback, execution, action_lookup
            )
            if result is not None:
                execution.results.append(result)
            execution.state.current_step_index = i + 1

    async def _execute_parallel(
        self,
        plan: ActionPlan,
        message: Memory,
        state: State | None,
        callback: HandlerCallback | None,
        execution: PlanExecution,
        action_lookup: dict[str, object],
    ) -> None:
        tasks = [
            self._execute_step(step, message, state, callback, execution, action_lookup)
            for step in plan.steps
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, ActionResult):
                execution.results.append(r)

    async def _execute_dag(
        self,
        plan: ActionPlan,
        message: Memory,
        state: State | None,
        callback: HandlerCallback | None,
        execution: PlanExecution,
        action_lookup: dict[str, object],
    ) -> None:
        import heapq

        by_id: dict[UUID, ActionStep] = {s.id: s for s in plan.steps}
        in_degree: dict[UUID, int] = {s.id: len(s.dependencies) for s in plan.steps}
        dependents: dict[UUID, list[UUID]] = {}
        index_by_id: dict[UUID, int] = {}
        for idx, step in enumerate(plan.steps):
            index_by_id[step.id] = idx
            for dep in step.dependencies:
                dependents.setdefault(dep, []).append(step.id)

        ready_heap: list[tuple[int, UUID]] = [
            (index_by_id[sid], sid) for sid, count in in_degree.items() if count == 0
        ]
        heapq.heapify(ready_heap)

        completed_count = 0
        while ready_heap and not execution.abort_event.is_set():
            ready_batch: list[ActionStep] = []
            while ready_heap:
                _, sid = heapq.heappop(ready_heap)
                ready_batch.append(by_id[sid])

            if not ready_batch:
                break

            results = await asyncio.gather(
                *[
                    self._execute_step(step, message, state, callback, execution, action_lookup)
                    for step in ready_batch
                ],
                return_exceptions=True,
            )

            for step, r in zip(ready_batch, results, strict=False):
                completed_count += 1
                if isinstance(r, ActionResult):
                    execution.results.append(r)

                for nxt in dependents.get(step.id, []):
                    remaining = in_degree.get(nxt, 0)
                    if remaining > 0:
                        remaining -= 1
                        in_degree[nxt] = remaining
                        if remaining == 0:
                            heapq.heappush(ready_heap, (index_by_id[nxt], nxt))

        if completed_count != len(plan.steps):
            raise RuntimeError("No steps ready to execute - possible circular dependency")

    async def _execute_step(
        self,
        step: ActionStep,
        message: Memory,
        state: State | None,
        callback: HandlerCallback | None,
        execution: PlanExecution,
        action_lookup: dict[str, object],
    ) -> ActionResult | None:
        action = self._find_action(step.action_name, action_lookup)
        if action is None:
            raise RuntimeError(f"Action '{step.action_name}' not found")

        previous_results = execution.results
        action_context = ActionContext(previous_results=previous_results)

        retries = 0
        max_retries = step.retry_policy.max_retries if step.retry_policy else 0
        while retries <= max_retries:
            if execution.abort_event.is_set():
                raise RuntimeError("Plan execution aborted")
            try:
                options = HandlerOptions(
                    action_context=action_context,
                    parameters=step.parameters,
                )
                # Attach extra execution context (allowed by extra="allow")
                options.previous_results = previous_results  # type: ignore[attr-defined]
                options.context = {"workingMemory": execution.working_memory}  # type: ignore[attr-defined]

                validate_fn = getattr(action, "validate", None) or getattr(
                    action, "validate_fn", None
                )
                ok = await validate_fn(self.runtime, message, state) if validate_fn else True
                if not ok:
                    return None

                result = await action.handler(self.runtime, message, state, options, callback, None)
                if result is None:
                    return None

                if result.data is None:
                    result.data = {}
                if isinstance(result.data, dict):
                    result.data["stepId"] = str(step.id)
                    result.data["actionName"] = step.action_name
                    result.data["executedAt"] = int(time.time() * 1000)
                return result
            except Exception as e:
                retries += 1
                if retries > max_retries:
                    raise e
                backoff = step.retry_policy.backoff_ms * (
                    step.retry_policy.backoff_multiplier ** (retries - 1)
                )
                await asyncio.sleep(backoff / 1000.0)

        return None

    async def get_plan_status(self, plan_id: UUID) -> PlanState | None:
        execution = self._executions.get(plan_id)
        return execution.state if execution else None

    async def cancel_plan(self, plan_id: UUID) -> bool:
        execution = self._executions.get(plan_id)
        if not execution:
            return False
        execution.abort_event.set()
        execution.state.status = "cancelled"
        execution.state.end_time = time.time()
        return True

    async def adapt_plan(
        self,
        plan: ActionPlan,
        current_step_index: int,
        results: list[ActionResult],
        error: Exception | None = None,
    ) -> ActionPlan:
        # For now, keep parity with TS structure by asking the model to return new steps.
        prompt = f"""You are an expert AI adaptation system. A plan execution has encountered an issue and needs adaptation.

ORIGINAL PLAN: {json.dumps({"id": str(plan.id), "goal": plan.goal, "steps": [{"id": str(s.id), "action": s.action_name} for s in plan.steps]}, indent=2)}
CURRENT STEP INDEX: {current_step_index}
COMPLETED RESULTS: {json.dumps([MessageToDict(r, preserving_proto_field_name=False) for r in results], indent=2)}
{f"ERROR: {str(error)}" if error else ""}

Return the adapted plan in the same XML format as the original planning response."""

        try:
            response = await self.runtime.use_model(
                "TEXT_LARGE",
                {"prompt": prompt, "temperature": 0.4, "maxTokens": 1500},
            )
            adapted = self._parse_plan(str(response), goal=plan.goal)
            new_steps = plan.steps[:current_step_index] + adapted.steps
            plan.steps = new_steps
            plan.total_steps = len(new_steps)
            return plan
        except Exception:
            # Fallback: append a REPLY step
            fallback = ActionStep(
                id=uuid4(),
                action_name="REPLY",
                parameters={"text": "Plan adaptation completed successfully"},
                dependencies=[],
            )
            plan.steps = plan.steps[:current_step_index] + [fallback]
            plan.total_steps = len(plan.steps)
            return plan
