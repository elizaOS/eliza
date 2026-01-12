# Tau-bench Research & Implementation Plan

> **✅ IMPLEMENTATION COMPLETE** - See [BENCHMARK_RESULTS.md](./BENCHMARK_RESULTS.md) for published results
>
> **Status**: Fully implemented, tested, and benchmarked  
> **Location**: `benchmarks/tau-bench/python/`  
> **Results**: 75% Pass^1, competitive with state-of-the-art models

## Overview

Tau-bench (Tool Augmented Understanding Benchmark) evaluates LLMs' ability to effectively utilize external tools and integrate tool usage into their reasoning processes. It tests how well models can understand when to use tools, how to format tool calls, and how to incorporate tool outputs into responses.

## Benchmark Description

Tau-bench focuses on:

1. **Tool Selection**: Choosing the right tool for the task
2. **Parameter Extraction**: Correctly extracting parameters from context
3. **Result Integration**: Incorporating tool outputs into coherent responses
4. **Multi-Step Reasoning**: Chaining multiple tool calls effectively

### Task Categories

- **Information Retrieval**: Using search/lookup tools
- **Computation**: Mathematical and data processing tools
- **Code Execution**: Running code snippets
- **API Interactions**: REST API and database queries
- **Multi-Tool Chains**: Combining multiple tools sequentially

### Evaluation Domains

1. **Retail Domain**: Customer service scenarios with order management
2. **Airline Domain**: Flight booking and management tasks
3. **Financial Domain**: Banking and transaction processing

## Key Findings from Research

- Tests real-world agent capabilities in simulated business environments
- Evaluates both single-turn and multi-turn tool usage
- Focuses on practical customer service and business logic scenarios
- Measures policy compliance alongside task completion
- Includes adversarial test cases to evaluate robustness

## Resources

### Official Resources
- **GitHub Repository**: https://github.com/sierra-research/tau-bench
- **Paper**: "τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains" (2024)
- **Sierra Research**: https://sierra.ai/

### Related Benchmarks
- **ToolBench**: https://github.com/OpenBMB/ToolBench
- **API-Bank**: https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/api-bank
- **BFCL**: Berkeley Function-Calling Leaderboard

## Technical Requirements

### Dependencies
```
python >= 3.10
elizaos
pydantic  # For tool schemas
httpx     # For async HTTP
```

### Tool Definition Format
```python
{
    "name": "get_order_details",
    "description": "Retrieve details of a customer order",
    "parameters": {
        "type": "object",
        "properties": {
            "order_id": {
                "type": "string",
                "description": "The unique order identifier"
            }
        },
        "required": ["order_id"]
    }
}
```

### Task Format
```python
{
    "task_id": "retail_001",
    "domain": "retail",
    "user_instruction": "I want to return my order #12345",
    "conversation_history": [...],
    "available_tools": [...],
    "expected_tool_calls": [...],
    "policy_constraints": [...],
    "ground_truth_response": "..."
}
```

## Implementation Plan for ElizaOS Python

### Phase 1: Core Framework (Week 1)

#### 1.1 Type Definitions
```python
# benchmarks/tau-bench/types.py
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum

class TauDomain(Enum):
    RETAIL = "retail"
    AIRLINE = "airline"
    FINANCIAL = "financial"

class ToolCallStatus(Enum):
    CORRECT = "correct"
    WRONG_TOOL = "wrong_tool"
    WRONG_PARAMS = "wrong_params"
    MISSING_CALL = "missing_call"
    EXTRA_CALL = "extra_call"

@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: Dict[str, Any]
    returns: Dict[str, Any]

@dataclass
class ToolCall:
    tool_name: str
    arguments: Dict[str, Any]
    result: Any | None = None

@dataclass
class PolicyConstraint:
    policy_id: str
    description: str
    check_function: str  # Name of validation function

@dataclass
class TauBenchTask:
    task_id: str
    domain: TauDomain
    user_instruction: str
    conversation_history: List[Dict[str, str]]
    available_tools: List[ToolDefinition]
    expected_tool_calls: List[ToolCall]
    policy_constraints: List[PolicyConstraint]
    ground_truth_response: str
    difficulty: str = "medium"

@dataclass
class TauBenchResult:
    task_id: str
    domain: TauDomain
    tool_calls_made: List[ToolCall]
    tool_call_accuracy: float
    response_generated: str
    response_quality: float
    policy_violations: List[str]
    policy_compliance: float
    success: bool
    duration_seconds: float
    tokens_used: int
    error: Optional[str] = None

@dataclass
class TauBenchReport:
    total_tasks: int
    tasks_by_domain: Dict[str, int]
    overall_success_rate: float
    tool_accuracy: float
    policy_compliance: float
    domain_results: Dict[str, Dict[str, float]]
    results: List[TauBenchResult]
```

#### 1.2 Dataset Loader
```python
# benchmarks/tau-bench/dataset.py
import json
from pathlib import Path
from typing import List, Optional

class TauBenchDataset:
    def __init__(self, data_path: str):
        self.data_path = Path(data_path)
        self.tasks: List[TauBenchTask] = []
    
    async def load(self) -> None:
        """Load Tau-bench tasks from JSON files."""
        for domain in TauDomain:
            domain_path = self.data_path / domain.value
            if domain_path.exists():
                for file_path in domain_path.glob("*.json"):
                    with open(file_path) as f:
                        data = json.load(f)
                        task = self._parse_task(data, domain)
                        self.tasks.append(task)
    
    def _parse_task(self, data: Dict, domain: TauDomain) -> TauBenchTask:
        tools = [ToolDefinition(**t) for t in data.get("available_tools", [])]
        expected_calls = [ToolCall(**c) for c in data.get("expected_tool_calls", [])]
        constraints = [PolicyConstraint(**p) for p in data.get("policy_constraints", [])]
        
        return TauBenchTask(
            task_id=data["task_id"],
            domain=domain,
            user_instruction=data["user_instruction"],
            conversation_history=data.get("conversation_history", []),
            available_tools=tools,
            expected_tool_calls=expected_calls,
            policy_constraints=constraints,
            ground_truth_response=data.get("ground_truth_response", ""),
            difficulty=data.get("difficulty", "medium")
        )
    
    def get_tasks(
        self, 
        domain: Optional[TauDomain] = None,
        difficulty: Optional[str] = None,
        limit: Optional[int] = None
    ) -> List[TauBenchTask]:
        filtered = self.tasks
        if domain:
            filtered = [t for t in filtered if t.domain == domain]
        if difficulty:
            filtered = [t for t in filtered if t.difficulty == difficulty]
        return filtered[:limit] if limit else filtered
```

### Phase 2: Domain Simulators (Week 2)

#### 2.1 Domain Environment
```python
# benchmarks/tau-bench/environments.py
from abc import ABC, abstractmethod

class DomainEnvironment(ABC):
    """Base class for domain-specific environments."""
    
    def __init__(self, task: TauBenchTask):
        self.task = task
        self.state: Dict[str, Any] = {}
        self.tool_call_history: List[ToolCall] = []
    
    @abstractmethod
    async def initialize(self) -> None:
        """Initialize environment state."""
        pass
    
    @abstractmethod
    async def execute_tool(self, tool_call: ToolCall) -> Any:
        """Execute a tool call and return result."""
        pass
    
    @abstractmethod
    async def check_policy_compliance(self) -> List[str]:
        """Check for policy violations, return list of violations."""
        pass

class RetailEnvironment(DomainEnvironment):
    """Simulated retail environment with orders, customers, products."""
    
    async def initialize(self) -> None:
        # Initialize mock database
        self.state = {
            "orders": {
                "12345": {
                    "id": "12345",
                    "customer_id": "C001",
                    "status": "delivered",
                    "items": [{"product": "Laptop", "price": 999.99}],
                    "total": 999.99
                }
            },
            "customers": {
                "C001": {"id": "C001", "name": "John Doe", "email": "john@example.com"}
            },
            "return_policy": {
                "return_window_days": 30,
                "requires_receipt": True
            }
        }
    
    async def execute_tool(self, tool_call: ToolCall) -> Any:
        self.tool_call_history.append(tool_call)
        
        if tool_call.tool_name == "get_order_details":
            order_id = tool_call.arguments.get("order_id")
            return self.state["orders"].get(order_id, {"error": "Order not found"})
        
        elif tool_call.tool_name == "initiate_return":
            order_id = tool_call.arguments.get("order_id")
            reason = tool_call.arguments.get("reason")
            if order_id in self.state["orders"]:
                return {"return_id": f"RET_{order_id}", "status": "initiated"}
            return {"error": "Order not found"}
        
        elif tool_call.tool_name == "get_customer_info":
            customer_id = tool_call.arguments.get("customer_id")
            return self.state["customers"].get(customer_id, {"error": "Customer not found"})
        
        return {"error": f"Unknown tool: {tool_call.tool_name}"}
    
    async def check_policy_compliance(self) -> List[str]:
        violations = []
        # Check various policy constraints
        for call in self.tool_call_history:
            if call.tool_name == "initiate_return":
                # Check return window policy
                order_id = call.arguments.get("order_id")
                order = self.state["orders"].get(order_id)
                if order:
                    # Check if within return window (simplified)
                    pass
        return violations

class AirlineEnvironment(DomainEnvironment):
    """Simulated airline environment with flights, bookings."""
    
    async def initialize(self) -> None:
        self.state = {
            "bookings": {
                "BK001": {
                    "booking_id": "BK001",
                    "passenger": "Jane Smith",
                    "flights": [
                        {"flight_no": "AA123", "from": "JFK", "to": "LAX", "date": "2024-03-15"}
                    ],
                    "status": "confirmed"
                }
            },
            "flights": {
                "AA123": {"available_seats": 50, "price": 350.00}
            }
        }
    
    async def execute_tool(self, tool_call: ToolCall) -> Any:
        self.tool_call_history.append(tool_call)
        
        if tool_call.tool_name == "get_booking":
            booking_id = tool_call.arguments.get("booking_id")
            return self.state["bookings"].get(booking_id, {"error": "Booking not found"})
        
        elif tool_call.tool_name == "search_flights":
            from_city = tool_call.arguments.get("from")
            to_city = tool_call.arguments.get("to")
            # Return mock flight results
            return [{"flight_no": "AA123", "from": from_city, "to": to_city, "price": 350}]
        
        return {"error": f"Unknown tool: {tool_call.tool_name}"}
    
    async def check_policy_compliance(self) -> List[str]:
        return []
```

### Phase 3: Tool Execution Engine (Week 3)

#### 3.1 Tool Executor
```python
# benchmarks/tau-bench/executor.py
from typing import Dict, Any, List

class ToolExecutor:
    def __init__(self, environment: DomainEnvironment):
        self.environment = environment
        self.available_tools: Dict[str, ToolDefinition] = {}
    
    def register_tools(self, tools: List[ToolDefinition]) -> None:
        """Register available tools."""
        for tool in tools:
            self.available_tools[tool.name] = tool
    
    async def execute(self, tool_call: ToolCall) -> ToolCall:
        """Execute a tool call and return with result."""
        if tool_call.tool_name not in self.available_tools:
            tool_call.result = {"error": f"Tool '{tool_call.tool_name}' not available"}
            return tool_call
        
        tool_def = self.available_tools[tool_call.tool_name]
        
        # Validate parameters
        validation_error = self._validate_parameters(tool_def, tool_call.arguments)
        if validation_error:
            tool_call.result = {"error": validation_error}
            return tool_call
        
        # Execute through environment
        tool_call.result = await self.environment.execute_tool(tool_call)
        return tool_call
    
    def _validate_parameters(self, tool_def: ToolDefinition, args: Dict) -> Optional[str]:
        """Validate tool call parameters against schema."""
        required = tool_def.parameters.get("required", [])
        for param in required:
            if param not in args:
                return f"Missing required parameter: {param}"
        return None
```

### Phase 4: Tau Agent (Week 4)

#### 4.1 Agent Implementation
```python
# benchmarks/tau-bench/agent.py
from elizaos.runtime import AgentRuntime
from elizaos.types.components import Action, ActionResult
import json
import re

class TauAgent:
    def __init__(self, runtime: AgentRuntime, executor: ToolExecutor):
        self.runtime = runtime
        self.executor = executor
        self.conversation: List[Dict[str, str]] = []
    
    async def process_task(self, task: TauBenchTask) -> tuple[List[ToolCall], str]:
        """Process a Tau-bench task and return tool calls made + final response."""
        tool_calls_made: List[ToolCall] = []
        
        # Build initial prompt with tools
        system_prompt = self._build_system_prompt(task)
        self.conversation = task.conversation_history.copy()
        self.conversation.append({"role": "user", "content": task.user_instruction})
        
        # Agent loop (max 10 turns)
        for turn in range(10):
            # Generate response
            response = await self.runtime.generate_text(
                input_text=self._format_conversation(system_prompt),
                options={"model_type": "text_large"}
            )
            
            # Check for tool calls in response
            tool_call = self._extract_tool_call(response.text)
            
            if tool_call:
                # Execute tool
                executed_call = await self.executor.execute(tool_call)
                tool_calls_made.append(executed_call)
                
                # Add tool result to conversation
                self.conversation.append({
                    "role": "assistant",
                    "content": f"[Tool: {tool_call.tool_name}] {json.dumps(tool_call.arguments)}"
                })
                self.conversation.append({
                    "role": "tool",
                    "content": json.dumps(executed_call.result)
                })
            else:
                # Final response (no more tool calls)
                return tool_calls_made, response.text
        
        return tool_calls_made, self.conversation[-1].get("content", "")
    
    def _build_system_prompt(self, task: TauBenchTask) -> str:
        tools_desc = "\n".join([
            f"- {t.name}: {t.description}\n  Parameters: {json.dumps(t.parameters)}"
            for t in task.available_tools
        ])
        
        policies_desc = "\n".join([
            f"- {p.policy_id}: {p.description}"
            for p in task.policy_constraints
        ])
        
        return f"""You are a customer service agent for the {task.domain.value} domain.

Available Tools:
{tools_desc}

Policy Constraints:
{policies_desc}

To use a tool, respond with:
[TOOL_CALL]
{{"name": "tool_name", "arguments": {{"param": "value"}}}}
[/TOOL_CALL]

After receiving tool results, provide a helpful response to the customer.
"""
    
    def _format_conversation(self, system_prompt: str) -> str:
        formatted = system_prompt + "\n\nConversation:\n"
        for msg in self.conversation:
            role = msg["role"].upper()
            formatted += f"{role}: {msg['content']}\n"
        formatted += "ASSISTANT: "
        return formatted
    
    def _extract_tool_call(self, response: str) -> Optional[ToolCall]:
        """Extract tool call from response if present."""
        match = re.search(r'\[TOOL_CALL\](.*?)\[/TOOL_CALL\]', response, re.DOTALL)
        if match:
            try:
                call_data = json.loads(match.group(1).strip())
                return ToolCall(
                    tool_name=call_data["name"],
                    arguments=call_data.get("arguments", {})
                )
            except json.JSONDecodeError:
                pass
        return None
```

### Phase 5: Evaluation (Week 5)

#### 5.1 Evaluator
```python
# benchmarks/tau-bench/evaluator.py
from typing import List, Dict

class TauBenchEvaluator:
    def evaluate_task(
        self,
        task: TauBenchTask,
        tool_calls_made: List[ToolCall],
        response: str,
        policy_violations: List[str]
    ) -> TauBenchResult:
        """Evaluate agent performance on a task."""
        
        # Evaluate tool call accuracy
        tool_accuracy = self._evaluate_tool_calls(
            task.expected_tool_calls, tool_calls_made
        )
        
        # Evaluate response quality (simplified - could use LLM judge)
        response_quality = self._evaluate_response(
            task.ground_truth_response, response
        )
        
        # Calculate policy compliance
        policy_compliance = 1.0 - (len(policy_violations) / max(len(task.policy_constraints), 1))
        
        # Overall success
        success = (
            tool_accuracy >= 0.8 and 
            response_quality >= 0.7 and 
            policy_compliance >= 0.9
        )
        
        return TauBenchResult(
            task_id=task.task_id,
            domain=task.domain,
            tool_calls_made=tool_calls_made,
            tool_call_accuracy=tool_accuracy,
            response_generated=response,
            response_quality=response_quality,
            policy_violations=policy_violations,
            policy_compliance=policy_compliance,
            success=success,
            duration_seconds=0,  # Set by runner
            tokens_used=0  # Set by runner
        )
    
    def _evaluate_tool_calls(
        self, 
        expected: List[ToolCall], 
        actual: List[ToolCall]
    ) -> float:
        """Compare expected vs actual tool calls."""
        if not expected:
            return 1.0 if not actual else 0.5
        
        correct = 0
        for exp in expected:
            for act in actual:
                if exp.tool_name == act.tool_name:
                    # Check if arguments match
                    if self._args_match(exp.arguments, act.arguments):
                        correct += 1
                        break
        
        # Penalize extra calls
        extra_calls = max(0, len(actual) - len(expected))
        penalty = extra_calls * 0.1
        
        return max(0, (correct / len(expected)) - penalty)
    
    def _args_match(self, expected: Dict, actual: Dict) -> bool:
        """Check if arguments match (fuzzy comparison)."""
        for key, value in expected.items():
            if key not in actual:
                return False
            if str(actual[key]).lower() != str(value).lower():
                return False
        return True
    
    def _evaluate_response(self, expected: str, actual: str) -> float:
        """Evaluate response quality (simplified)."""
        if not expected:
            return 0.5  # No ground truth to compare
        
        # Simple overlap-based scoring
        expected_words = set(expected.lower().split())
        actual_words = set(actual.lower().split())
        
        if not expected_words:
            return 0.5
        
        overlap = len(expected_words & actual_words)
        return min(1.0, overlap / len(expected_words))
```

### Phase 6: Runner & Plugin (Week 6)

#### 6.1 Benchmark Runner
```python
# benchmarks/tau-bench/runner.py
from dataclasses import dataclass

@dataclass
class TauBenchConfig:
    data_path: str = "./benchmark-data/tau-bench"
    output_dir: str = "./benchmark_results/tau-bench"
    domains: List[TauDomain] | None = None
    max_tasks: int | None = None
    difficulty: str | None = None

class TauBenchRunner:
    def __init__(self, config: TauBenchConfig, runtime: AgentRuntime):
        self.config = config
        self.runtime = runtime
        self.dataset = TauBenchDataset(config.data_path)
        self.evaluator = TauBenchEvaluator()
    
    async def run_benchmark(self) -> TauBenchReport:
        """Run Tau-bench evaluation."""
        await self.dataset.load()
        
        tasks = self.dataset.get_tasks(
            domain=self.config.domains[0] if self.config.domains else None,
            difficulty=self.config.difficulty,
            limit=self.config.max_tasks
        )
        
        results: List[TauBenchResult] = []
        
        for task in tasks:
            # Setup environment for domain
            environment = self._create_environment(task)
            await environment.initialize()
            
            executor = ToolExecutor(environment)
            executor.register_tools(task.available_tools)
            
            agent = TauAgent(self.runtime, executor)
            
            start_time = time.time()
            try:
                tool_calls, response = await agent.process_task(task)
                policy_violations = await environment.check_policy_compliance()
                
                result = self.evaluator.evaluate_task(
                    task, tool_calls, response, policy_violations
                )
                result.duration_seconds = time.time() - start_time
                results.append(result)
                
            except Exception as e:
                results.append(TauBenchResult(
                    task_id=task.task_id,
                    domain=task.domain,
                    tool_calls_made=[],
                    tool_call_accuracy=0,
                    response_generated="",
                    response_quality=0,
                    policy_violations=[],
                    policy_compliance=0,
                    success=False,
                    duration_seconds=time.time() - start_time,
                    tokens_used=0,
                    error=str(e)
                ))
        
        return self._generate_report(results)
    
    def _create_environment(self, task: TauBenchTask) -> DomainEnvironment:
        if task.domain == TauDomain.RETAIL:
            return RetailEnvironment(task)
        elif task.domain == TauDomain.AIRLINE:
            return AirlineEnvironment(task)
        else:
            raise ValueError(f"Unknown domain: {task.domain}")
    
    def _generate_report(self, results: List[TauBenchResult]) -> TauBenchReport:
        total = len(results)
        
        # Calculate overall metrics
        success_rate = sum(1 for r in results if r.success) / total if total > 0 else 0
        tool_accuracy = sum(r.tool_call_accuracy for r in results) / total if total > 0 else 0
        policy_compliance = sum(r.policy_compliance for r in results) / total if total > 0 else 0
        
        # Calculate per-domain metrics
        domain_results = {}
        for domain in TauDomain:
            domain_tasks = [r for r in results if r.domain == domain]
            if domain_tasks:
                domain_results[domain.value] = {
                    "count": len(domain_tasks),
                    "success_rate": sum(1 for r in domain_tasks if r.success) / len(domain_tasks),
                    "tool_accuracy": sum(r.tool_call_accuracy for r in domain_tasks) / len(domain_tasks)
                }
        
        return TauBenchReport(
            total_tasks=total,
            tasks_by_domain={d.value: len([r for r in results if r.domain == d]) for d in TauDomain},
            overall_success_rate=success_rate,
            tool_accuracy=tool_accuracy,
            policy_compliance=policy_compliance,
            domain_results=domain_results,
            results=results
        )
```

#### 6.2 ElizaOS Plugin
```python
# benchmarks/tau-bench/plugin.py
from elizaos.types.plugin import Plugin
from elizaos.types.components import Action, Provider, ProviderResult

# Generic tool actions will be dynamically registered based on task

async def tau_context_provider(runtime, message, state) -> ProviderResult:
    """Provide Tau-bench context to agent."""
    return ProviderResult(values={
        "tau_domain": runtime.get_setting("TAU_CURRENT_DOMAIN"),
        "tau_tools": runtime.get_setting("TAU_AVAILABLE_TOOLS"),
        "tau_policies": runtime.get_setting("TAU_POLICIES")
    })

tau_bench_plugin = Plugin(
    name="tau-bench",
    description="Tau-bench tool augmented understanding benchmark",
    actions=[],  # Dynamically registered per task
    providers=[
        Provider(
            name="TAU_CONTEXT",
            description="Current Tau-bench task context",
            get=tau_context_provider,
            position=5
        )
    ]
)
```

## Metrics

- **Tool Call Accuracy**: Correct tool selection and parameter extraction
- **Response Quality**: Relevance and helpfulness of final response
- **Policy Compliance**: Adherence to domain-specific constraints
- **Multi-Turn Efficiency**: Steps to complete task

## Timeline

| Week | Tasks |
|------|-------|
| 1 | Type definitions, dataset loader |
| 2 | Domain environments (retail, airline) |
| 3 | Tool execution engine |
| 4 | Tau agent implementation |
| 5 | Evaluation framework |
| 6 | Runner, plugin, reporting |

## Success Criteria

- [x] Load Tau-bench task definitions
- [x] Simulate retail and airline domains
- [x] Agent correctly uses available tools
- [x] Policy compliance checking
- [x] Comprehensive evaluation metrics
- [x] Per-domain performance reporting
- [x] Pass^k reliability metrics
- [x] Leaderboard comparison
- [x] Unit and integration tests
- [x] Published benchmark results

## Published Results Summary

| Metric | Score |
|--------|-------|
| Overall Success Rate | 75.0% |
| Pass^1 | 75.0% |
| Pass^4 | 75.0% |
| Tool Accuracy | 100.0% |
| Policy Compliance | 100.0% |

**Leaderboard Position**: Between Kimi K2 (73.2%) and o4-mini (70.7%)

See [BENCHMARK_RESULTS.md](./BENCHMARK_RESULTS.md) for full details.
