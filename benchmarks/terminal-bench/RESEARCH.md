# Terminal-Bench Research & Implementation Plan

## Implementation Status: ✅ COMPLETE

The Terminal-Bench benchmark has been fully implemented for ElizaOS Python. All components are tested and functional.

### Quick Start

```bash
# Install the benchmark
cd benchmarks/terminal-bench/python
pip install -e ".[dev]"

# Run with sample tasks (quick test)
terminal-bench --sample --verbose

# Test Docker environment
python scripts/test_docker.py

# Run full benchmark (requires OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...
terminal-bench --sample
```

### Test Results

```
============================= test session starts ==============================
platform darwin -- Python 3.13.2, pytest-9.0.2
collected 89 items / 8 deselected / 81 selected
======================= 81 passed, 8 deselected in 8.69s =======================
```

---

## Overview

Terminal-Bench is an open-source benchmark designed to evaluate AI agents' proficiency in performing complex tasks within terminal environments. It encompasses diverse tasks including code compilation, system administration, and machine learning model training, reflecting real-world challenges faced by software engineers.

## Key Resources

### Official Resources
- **GitHub Repository**: https://github.com/laude-institute/terminal-bench
- **Official Website**: https://tbench.ai
- **Leaderboard**: https://tbench.ai/leaderboard/terminal-bench/2.0

### Version History
- **Terminal-Bench 1.0**: Initial release with varied tasks
- **Terminal-Bench 2.0** (November 2025): 89 rigorously validated tasks with improved reliability and reproducibility

### Related Frameworks
- **Harbor Framework**: Enables sandboxed agent evaluations in cloud containers for large-scale testing

## Benchmark Structure

### Task Components
Each task in Terminal-Bench includes:
1. **Instruction**: Clear description of the task in English
2. **Test Script**: Script to verify successful task completion
3. **Reference Solution**: Example solution that accomplishes the task

### Task Categories
- Code compilation and build systems
- System administration tasks
- Machine learning model training
- File system operations
- Package management
- Network configuration
- Database operations
- Script writing and debugging

### Execution Harness
- Connects language models to sandboxed terminal environment
- Controlled execution and evaluation environment
- Supports various shell types (bash, zsh, etc.)

## Current Leaderboard (December 2025)

| Rank | Agent | Model | Accuracy |
|------|-------|-------|----------|
| 1 | Droid (Factory) | GPT-5.2 | 64.9% |
| 2 | Ante (Antigma Labs) | Gemini 3 Pro | 64.7% |
| 3 | Junie CLI (JetBrains) | Gemini 3 Flash | 64.3% |

**Note**: No agent has surpassed 65% success rate, indicating the benchmark's challenging nature.

## Technical Requirements

### Core Dependencies
```
docker>=24.0
subprocess
asyncio
aiofiles
pexpect
paramiko  # For SSH-based terminal access
```

### Environment Requirements
- Docker for sandboxed terminal environments
- Linux-based containers
- Configurable resource limits (CPU, memory)
- Network isolation capabilities

## Implementation Plan for ElizaOS

### Phase 1: Core Types and Data Structures

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from datetime import datetime

class TaskCategory(Enum):
    CODE_COMPILATION = "code_compilation"
    SYSTEM_ADMIN = "system_admin"
    ML_TRAINING = "ml_training"
    FILE_OPERATIONS = "file_operations"
    PACKAGE_MANAGEMENT = "package_management"
    NETWORK_CONFIG = "network_config"
    DATABASE = "database"
    SCRIPTING = "scripting"

class TaskDifficulty(Enum):
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"

@dataclass
class TerminalTask:
    """Represents a single Terminal-Bench task."""
    task_id: str
    instruction: str
    category: TaskCategory
    difficulty: TaskDifficulty
    test_script: str
    reference_solution: str
    timeout_seconds: int = 300
    required_tools: list[str] = field(default_factory=list)
    initial_state: Optional[str] = None

@dataclass
class TerminalCommand:
    """Represents a terminal command executed by the agent."""
    command: str
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float
    timestamp: datetime

@dataclass
class TerminalSession:
    """Represents an agent's terminal session."""
    session_id: str
    task: TerminalTask
    commands: list[TerminalCommand]
    working_directory: str
    environment_vars: dict[str, str]
    start_time: datetime
    end_time: Optional[datetime] = None

@dataclass
class TerminalBenchResult:
    """Result of a single task evaluation."""
    task_id: str
    success: bool
    commands_executed: int
    total_execution_time_ms: float
    test_output: str
    error_message: Optional[str] = None
    tokens_used: int = 0

@dataclass
class TerminalBenchReport:
    """Aggregate report for Terminal-Bench evaluation."""
    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    accuracy: float
    results: list[TerminalBenchResult]
    total_commands: int
    avg_commands_per_task: float
    total_tokens: int
    evaluation_time_seconds: float
```

### Phase 2: Dataset Loader

```python
import json
from pathlib import Path
from typing import Iterator

class TerminalBenchDataset:
    """Loads and manages Terminal-Bench task data."""
    
    def __init__(self, data_path: Path, version: str = "2.0"):
        self.data_path = data_path
        self.version = version
        self.tasks: list[TerminalTask] = []
        
    async def load(self) -> None:
        """Load tasks from the Terminal-Bench dataset."""
        tasks_path = self.data_path / "tasks"
        
        for task_dir in tasks_path.iterdir():
            if not task_dir.is_dir():
                continue
                
            # Load task metadata
            metadata_path = task_dir / "metadata.json"
            if not metadata_path.exists():
                continue
                
            with open(metadata_path) as f:
                metadata = json.load(f)
            
            # Load instruction
            instruction_path = task_dir / "instruction.txt"
            instruction = instruction_path.read_text() if instruction_path.exists() else ""
            
            # Load test script
            test_script_path = task_dir / "test.sh"
            test_script = test_script_path.read_text() if test_script_path.exists() else ""
            
            # Load reference solution
            solution_path = task_dir / "solution.sh"
            reference_solution = solution_path.read_text() if solution_path.exists() else ""
            
            task = TerminalTask(
                task_id=task_dir.name,
                instruction=instruction,
                category=TaskCategory(metadata.get("category", "scripting")),
                difficulty=TaskDifficulty(metadata.get("difficulty", "medium")),
                test_script=test_script,
                reference_solution=reference_solution,
                timeout_seconds=metadata.get("timeout", 300),
                required_tools=metadata.get("required_tools", []),
                initial_state=metadata.get("initial_state")
            )
            self.tasks.append(task)
    
    def filter_by_category(self, category: TaskCategory) -> list[TerminalTask]:
        """Filter tasks by category."""
        return [t for t in self.tasks if t.category == category]
    
    def filter_by_difficulty(self, difficulty: TaskDifficulty) -> list[TerminalTask]:
        """Filter tasks by difficulty."""
        return [t for t in self.tasks if t.difficulty == difficulty]
    
    def __iter__(self) -> Iterator[TerminalTask]:
        return iter(self.tasks)
    
    def __len__(self) -> int:
        return len(self.tasks)
```

### Phase 3: Terminal Environment Manager

```python
import asyncio
import docker
from typing import Optional

class TerminalEnvironment:
    """Manages sandboxed terminal environment for task execution."""
    
    def __init__(
        self,
        image: str = "ubuntu:22.04",
        memory_limit: str = "2g",
        cpu_limit: float = 1.0
    ):
        self.image = image
        self.memory_limit = memory_limit
        self.cpu_limit = cpu_limit
        self.client = docker.from_env()
        self.container: Optional[docker.models.containers.Container] = None
        
    async def start(self, task: TerminalTask) -> None:
        """Start the terminal environment."""
        # Build container configuration
        config = {
            "image": self.image,
            "detach": True,
            "tty": True,
            "stdin_open": True,
            "mem_limit": self.memory_limit,
            "cpu_period": 100000,
            "cpu_quota": int(100000 * self.cpu_limit),
            "network_mode": "none",  # Isolated by default
            "working_dir": "/workspace"
        }
        
        # Create and start container
        self.container = self.client.containers.run(**config)
        
        # Apply initial state if specified
        if task.initial_state:
            await self.execute(task.initial_state)
    
    async def execute(self, command: str) -> TerminalCommand:
        """Execute a command in the terminal environment."""
        if not self.container:
            raise RuntimeError("Terminal environment not started")
        
        start_time = asyncio.get_event_loop().time()
        
        # Execute command
        exit_code, output = self.container.exec_run(
            cmd=["bash", "-c", command],
            demux=True
        )
        
        execution_time = (asyncio.get_event_loop().time() - start_time) * 1000
        
        stdout, stderr = output if output else (b"", b"")
        
        return TerminalCommand(
            command=command,
            stdout=stdout.decode() if stdout else "",
            stderr=stderr.decode() if stderr else "",
            exit_code=exit_code,
            execution_time_ms=execution_time,
            timestamp=datetime.now()
        )
    
    async def run_test(self, test_script: str) -> tuple[bool, str]:
        """Run the test script to verify task completion."""
        # Write test script to container
        await self.execute(f"cat << 'EOF' > /tmp/test.sh\n{test_script}\nEOF")
        await self.execute("chmod +x /tmp/test.sh")
        
        # Run test
        result = await self.execute("/tmp/test.sh")
        
        return result.exit_code == 0, result.stdout + result.stderr
    
    async def stop(self) -> None:
        """Stop and clean up the terminal environment."""
        if self.container:
            self.container.stop()
            self.container.remove()
            self.container = None
    
    async def get_file_content(self, path: str) -> str:
        """Get content of a file in the container."""
        result = await self.execute(f"cat {path}")
        return result.stdout
    
    async def list_directory(self, path: str = ".") -> list[str]:
        """List directory contents."""
        result = await self.execute(f"ls -la {path}")
        return result.stdout.split("\n")
```

### Phase 4: ElizaOS Terminal Agent

```python
from elizaos import Action, Plugin, Provider
from elizaos.runtime import AgentRuntime
from elizaos.types import Memory, State, Content

# Terminal execution action
execute_command_action = Action(
    name="EXECUTE_TERMINAL_COMMAND",
    description="Execute a command in the terminal environment",
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to execute"
            }
        },
        "required": ["command"]
    },
    handler=None  # Set during agent initialization
)

# File read action
read_file_action = Action(
    name="READ_FILE",
    description="Read the contents of a file",
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to read"
            }
        },
        "required": ["path"]
    },
    handler=None
)

# Directory listing action
list_directory_action = Action(
    name="LIST_DIRECTORY",
    description="List contents of a directory",
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the directory (default: current directory)"
            }
        },
        "required": []
    },
    handler=None
)

# Write file action
write_file_action = Action(
    name="WRITE_FILE",
    description="Write content to a file",
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to write"
            },
            "content": {
                "type": "string",
                "description": "Content to write to the file"
            }
        },
        "required": ["path", "content"]
    },
    handler=None
)


class TerminalAgent:
    """ElizaOS agent for Terminal-Bench tasks."""
    
    def __init__(self, runtime: AgentRuntime, environment: TerminalEnvironment):
        self.runtime = runtime
        self.environment = environment
        self.session: Optional[TerminalSession] = None
        self._setup_actions()
    
    def _setup_actions(self) -> None:
        """Configure action handlers."""
        
        async def execute_handler(params: dict, state: State) -> Content:
            command = params["command"]
            result = await self.environment.execute(command)
            
            # Track command in session
            if self.session:
                self.session.commands.append(result)
            
            return Content(
                text=f"Exit code: {result.exit_code}\n"
                     f"stdout:\n{result.stdout}\n"
                     f"stderr:\n{result.stderr}"
            )
        
        async def read_file_handler(params: dict, state: State) -> Content:
            path = params["path"]
            content = await self.environment.get_file_content(path)
            return Content(text=content)
        
        async def list_dir_handler(params: dict, state: State) -> Content:
            path = params.get("path", ".")
            entries = await self.environment.list_directory(path)
            return Content(text="\n".join(entries))
        
        async def write_file_handler(params: dict, state: State) -> Content:
            path = params["path"]
            content = params["content"]
            # Escape content for shell
            escaped = content.replace("'", "'\\''")
            result = await self.environment.execute(f"cat << 'ELIZAEOF' > {path}\n{content}\nELIZAEOF")
            return Content(text=f"File written: {path}" if result.exit_code == 0 else f"Error: {result.stderr}")
        
        execute_command_action.handler = execute_handler
        read_file_action.handler = read_file_handler
        list_directory_action.handler = list_dir_handler
        write_file_action.handler = write_file_handler
    
    async def solve_task(self, task: TerminalTask, max_iterations: int = 20) -> TerminalBenchResult:
        """Attempt to solve a Terminal-Bench task."""
        # Initialize session
        self.session = TerminalSession(
            session_id=f"session_{task.task_id}_{datetime.now().isoformat()}",
            task=task,
            commands=[],
            working_directory="/workspace",
            environment_vars={},
            start_time=datetime.now()
        )
        
        # Start environment
        await self.environment.start(task)
        
        try:
            # Build initial prompt
            system_prompt = self._build_system_prompt()
            user_prompt = self._build_task_prompt(task)
            
            tokens_used = 0
            
            for iteration in range(max_iterations):
                # Get agent's next action
                response = await self.runtime.generate_response(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    actions=[
                        execute_command_action,
                        read_file_action,
                        list_directory_action,
                        write_file_action
                    ]
                )
                
                tokens_used += response.tokens_used
                
                # Check if agent indicates completion
                if self._check_completion_signal(response):
                    break
                
                # Execute any actions
                if response.action:
                    action_result = await self._execute_action(response.action)
                    user_prompt = self._build_continuation_prompt(action_result)
            
            # Run test script
            success, test_output = await self.environment.run_test(task.test_script)
            
            self.session.end_time = datetime.now()
            
            return TerminalBenchResult(
                task_id=task.task_id,
                success=success,
                commands_executed=len(self.session.commands),
                total_execution_time_ms=sum(c.execution_time_ms for c in self.session.commands),
                test_output=test_output,
                tokens_used=tokens_used
            )
            
        finally:
            await self.environment.stop()
    
    def _build_system_prompt(self) -> str:
        """Build system prompt for the terminal agent."""
        return """You are an expert terminal/shell operator. Your task is to complete 
the given task using terminal commands. You have access to a Linux terminal environment.

Available tools:
- EXECUTE_TERMINAL_COMMAND: Run shell commands
- READ_FILE: Read file contents
- LIST_DIRECTORY: List directory contents
- WRITE_FILE: Write content to a file

Guidelines:
1. Think step-by-step about what commands to run
2. Check the current state before making changes
3. Verify your work after making changes
4. Use appropriate error handling
5. Signal completion when the task is done

When you believe the task is complete, say "TASK_COMPLETE" in your response."""
    
    def _build_task_prompt(self, task: TerminalTask) -> str:
        """Build initial task prompt."""
        return f"""Task: {task.instruction}

Category: {task.category.value}
Timeout: {task.timeout_seconds} seconds

Begin working on this task. Start by understanding the current environment state."""
    
    def _build_continuation_prompt(self, action_result: Content) -> str:
        """Build continuation prompt with action results."""
        return f"""Previous action result:
{action_result.text}

Continue working on the task. What's the next step?"""
    
    def _check_completion_signal(self, response) -> bool:
        """Check if agent signals task completion."""
        return "TASK_COMPLETE" in response.text.upper()
    
    async def _execute_action(self, action) -> Content:
        """Execute the selected action."""
        handler = action.handler
        return await handler(action.parameters, {})
```

### Phase 5: Benchmark Runner

```python
import asyncio
from pathlib import Path
from typing import Optional
import json

class TerminalBenchRunner:
    """Orchestrates Terminal-Bench evaluation."""
    
    def __init__(
        self,
        runtime: AgentRuntime,
        data_path: Path,
        output_path: Path,
        version: str = "2.0"
    ):
        self.runtime = runtime
        self.data_path = data_path
        self.output_path = output_path
        self.version = version
        self.dataset: Optional[TerminalBenchDataset] = None
    
    async def setup(self) -> None:
        """Initialize the benchmark runner."""
        self.dataset = TerminalBenchDataset(self.data_path, self.version)
        await self.dataset.load()
        self.output_path.mkdir(parents=True, exist_ok=True)
    
    async def run(
        self,
        categories: Optional[list[TaskCategory]] = None,
        difficulties: Optional[list[TaskDifficulty]] = None,
        task_ids: Optional[list[str]] = None,
        max_tasks: Optional[int] = None
    ) -> TerminalBenchReport:
        """Run the benchmark evaluation."""
        if not self.dataset:
            raise RuntimeError("Runner not initialized. Call setup() first.")
        
        # Filter tasks
        tasks = list(self.dataset.tasks)
        
        if categories:
            tasks = [t for t in tasks if t.category in categories]
        if difficulties:
            tasks = [t for t in tasks if t.difficulty in difficulties]
        if task_ids:
            tasks = [t for t in tasks if t.task_id in task_ids]
        if max_tasks:
            tasks = tasks[:max_tasks]
        
        results: list[TerminalBenchResult] = []
        start_time = asyncio.get_event_loop().time()
        
        for task in tasks:
            print(f"Running task: {task.task_id} ({task.category.value})")
            
            # Create fresh environment and agent for each task
            environment = TerminalEnvironment()
            agent = TerminalAgent(self.runtime, environment)
            
            try:
                result = await agent.solve_task(task)
                results.append(result)
                
                print(f"  Result: {'PASS' if result.success else 'FAIL'}")
                print(f"  Commands: {result.commands_executed}")
                
            except Exception as e:
                results.append(TerminalBenchResult(
                    task_id=task.task_id,
                    success=False,
                    commands_executed=0,
                    total_execution_time_ms=0,
                    test_output="",
                    error_message=str(e)
                ))
                print(f"  Error: {e}")
        
        # Calculate metrics
        passed = sum(1 for r in results if r.success)
        total_commands = sum(r.commands_executed for r in results)
        total_tokens = sum(r.tokens_used for r in results)
        
        report = TerminalBenchReport(
            total_tasks=len(results),
            passed_tasks=passed,
            failed_tasks=len(results) - passed,
            accuracy=passed / len(results) if results else 0,
            results=results,
            total_commands=total_commands,
            avg_commands_per_task=total_commands / len(results) if results else 0,
            total_tokens=total_tokens,
            evaluation_time_seconds=asyncio.get_event_loop().time() - start_time
        )
        
        # Save report
        await self._save_report(report)
        
        return report
    
    async def _save_report(self, report: TerminalBenchReport) -> None:
        """Save benchmark report to disk."""
        report_path = self.output_path / f"report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        report_dict = {
            "version": self.version,
            "total_tasks": report.total_tasks,
            "passed_tasks": report.passed_tasks,
            "failed_tasks": report.failed_tasks,
            "accuracy": report.accuracy,
            "total_commands": report.total_commands,
            "avg_commands_per_task": report.avg_commands_per_task,
            "total_tokens": report.total_tokens,
            "evaluation_time_seconds": report.evaluation_time_seconds,
            "results": [
                {
                    "task_id": r.task_id,
                    "success": r.success,
                    "commands_executed": r.commands_executed,
                    "total_execution_time_ms": r.total_execution_time_ms,
                    "tokens_used": r.tokens_used,
                    "error_message": r.error_message
                }
                for r in report.results
            ]
        }
        
        with open(report_path, 'w') as f:
            json.dump(report_dict, f, indent=2)
        
        # Also generate markdown report
        markdown_path = self.output_path / f"report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        markdown = self._generate_markdown_report(report)
        with open(markdown_path, 'w') as f:
            f.write(markdown)
    
    def _generate_markdown_report(self, report: TerminalBenchReport) -> str:
        """Generate a markdown summary report."""
        return f"""# Terminal-Bench Evaluation Report

## Summary

| Metric | Value |
|--------|-------|
| Total Tasks | {report.total_tasks} |
| Passed | {report.passed_tasks} |
| Failed | {report.failed_tasks} |
| Accuracy | {report.accuracy:.2%} |
| Total Commands | {report.total_commands} |
| Avg Commands/Task | {report.avg_commands_per_task:.1f} |
| Total Tokens | {report.total_tokens:,} |
| Evaluation Time | {report.evaluation_time_seconds:.1f}s |

## Results by Task

| Task ID | Status | Commands | Execution Time |
|---------|--------|----------|----------------|
{''.join(f"| {r.task_id} | {'✅' if r.success else '❌'} | {r.commands_executed} | {r.total_execution_time_ms:.1f}ms |" + chr(10) for r in report.results)}

## Failed Tasks

{chr(10).join(f"- **{r.task_id}**: {r.error_message or 'Test failed'}" for r in report.results if not r.success) or "None"}
"""


# Plugin definition
terminal_bench_plugin = Plugin(
    name="terminal-bench",
    description="Terminal-Bench benchmark evaluation for ElizaOS",
    actions=[
        execute_command_action,
        read_file_action,
        list_directory_action,
        write_file_action
    ],
    providers=[],
    evaluators=[]
)
```

### Phase 6: Usage Example

```python
import asyncio
from pathlib import Path
from elizaos.runtime import AgentRuntime

async def run_terminal_bench():
    """Example of running Terminal-Bench evaluation."""
    # Initialize runtime
    runtime = AgentRuntime()
    await runtime.initialize()
    
    # Register plugin
    runtime.register_plugin(terminal_bench_plugin)
    
    # Create runner
    runner = TerminalBenchRunner(
        runtime=runtime,
        data_path=Path("./terminal-bench-data"),
        output_path=Path("./results/terminal-bench"),
        version="2.0"
    )
    
    await runner.setup()
    
    # Run full benchmark
    report = await runner.run()
    
    print(f"\n=== Terminal-Bench Results ===")
    print(f"Accuracy: {report.accuracy:.2%}")
    print(f"Passed: {report.passed_tasks}/{report.total_tasks}")
    
    # Run specific categories
    code_report = await runner.run(
        categories=[TaskCategory.CODE_COMPILATION],
        max_tasks=10
    )
    
    print(f"\nCode Compilation Accuracy: {code_report.accuracy:.2%}")

if __name__ == "__main__":
    asyncio.run(run_terminal_bench())
```

## Implementation Roadmap

### Week 1-2: Foundation
- [ ] Set up Docker-based terminal environment
- [ ] Implement core types and data structures
- [ ] Create dataset loader with task validation

### Week 3-4: Agent Development
- [ ] Implement terminal action handlers
- [ ] Build TerminalAgent with proper tool selection
- [ ] Add session tracking and logging

### Week 5-6: Evaluation System
- [ ] Implement test script execution
- [ ] Build benchmark runner with metrics
- [ ] Create report generation (JSON + Markdown)

### Week 7-8: Testing & Optimization
- [ ] Test with Terminal-Bench 2.0 tasks
- [ ] Optimize agent prompts for better performance
- [ ] Add error handling and recovery
- [ ] Document API and usage patterns

## Key Challenges

1. **Sandboxed Execution**: Ensuring commands run in isolated containers
2. **State Management**: Tracking terminal state across multiple commands
3. **Timeout Handling**: Gracefully handling hung commands
4. **Test Verification**: Reliably running test scripts for pass/fail determination
5. **Resource Management**: Cleaning up containers after task completion

## Success Metrics

- Primary: Task completion accuracy (target: >50%)
- Secondary: Average commands per successful task
- Tertiary: Token efficiency (accuracy per token)

---

## ElizaOS Implementation Details

### Package Structure

```
benchmarks/terminal-bench/python/
├── pyproject.toml                    # Package configuration
├── README.md                         # Documentation
├── elizaos_terminal_bench/
│   ├── __init__.py                   # Package exports
│   ├── types.py                      # Data classes and enums
│   ├── dataset.py                    # Task loading
│   ├── environment.py                # Docker terminal management
│   ├── agent.py                      # ElizaOS terminal agent
│   ├── evaluator.py                  # Task verification & metrics
│   ├── runner.py                     # Benchmark orchestration
│   └── cli.py                        # Command-line interface
├── scripts/
│   ├── run_benchmark.py              # Benchmark runner script
│   └── test_docker.py                # Docker environment test
└── tests/
    ├── test_types.py
    ├── test_dataset.py
    ├── test_environment.py
    ├── test_agent.py
    ├── test_evaluator.py
    └── test_runner.py
```

### Key Components

1. **TerminalEnvironment**: Docker-based sandboxed execution
   - Configurable resource limits (CPU, memory)
   - Network isolation options
   - Automatic cleanup

2. **TerminalAgent**: LLM-powered task solver
   - Multi-action support (EXECUTE, READ_FILE, WRITE_FILE, LIST_DIR)
   - Session tracking and logging
   - Iteration limits and timeout handling

3. **TerminalBenchEvaluator**: Test verification
   - Script-based test execution
   - Category/difficulty breakdown
   - Leaderboard comparison

4. **TerminalBenchRunner**: Full pipeline orchestration
   - Parallel task support (planned)
   - JSON and Markdown report generation
   - Session log storage

### CLI Usage

```bash
# Run sample tasks
terminal-bench --sample

# Filter by category
terminal-bench --categories scripting code_compilation

# Filter by difficulty
terminal-bench --difficulties easy medium

# Use specific model
terminal-bench --model gpt-4-turbo

# Dry run (no execution)
terminal-bench --sample --dry-run

# Verbose output
terminal-bench --sample --verbose
```

### Python API

```python
from elizaos_terminal_bench import (
    TerminalBenchRunner,
    TerminalBenchConfig,
    TaskCategory,
)

async def main():
    config = TerminalBenchConfig(
        output_dir="./results",
        max_iterations=20,
        model_name="gpt-4",
    )
    
    runner = TerminalBenchRunner(config=config)
    await runner.setup(use_sample_tasks=True)
    
    report = await runner.run()
    
    print(f"Accuracy: {report.accuracy:.1%}")
    print(f"Rank: #{report.leaderboard_comparison.rank}")
```

### Sample Benchmark Report

The benchmark generates comprehensive reports in JSON and Markdown formats:

```markdown
# Terminal-Bench Evaluation Report

## Summary

| Metric | Value |
|--------|-------|
| Total Tasks | 5 |
| Passed | 3 |
| Failed | 2 |
| Accuracy | 60.0% |
| Total Commands | 25 |
| Avg Commands/Task | 5.0 |

## Leaderboard Comparison

| System | Score |
|--------|-------|
| Human Expert | 92.5% |
| Droid (Factory) + GPT-5.2 | 64.9% |
| **ElizaOS (This Run)** | **60.0%** |
| ...
```

### Running the Full Benchmark

To run the complete Terminal-Bench evaluation:

1. **Prerequisites**:
   ```bash
   # Docker must be running
   docker info
   
   # Set OpenAI API key
   export OPENAI_API_KEY=sk-...
   ```

2. **Run Sample Tasks** (quick validation):
   ```bash
   terminal-bench --sample --verbose
   ```

3. **Run Full Dataset** (when available):
   ```bash
   terminal-bench --data-path ./terminal-bench-data --verbose
   ```

4. **View Results**:
   ```bash
   cat benchmark_results/terminal-bench/terminal-bench-*.md
   ```

### Expected Performance

Based on the leaderboard and our implementation:

| Model | Expected Accuracy | Notes |
|-------|------------------|-------|
| GPT-4 | 40-50% | Good tool use, reasoning |
| GPT-4 Turbo | 45-55% | Faster, similar quality |
| Claude 3.5 Sonnet | 50-60% | Strong coding abilities |
| GPT-4o | 45-55% | Balanced performance |

**Target**: Achieve >50% accuracy to compete with mid-tier agents.

### Future Improvements

1. **Parallel Task Execution**: Run multiple tasks concurrently
2. **Custom Tool Definitions**: Add specialized tools for specific task types
3. **Trajectory Analysis**: Detailed analysis of successful vs failed paths
4. **Few-shot Learning**: Include examples in prompts
5. **RAG Integration**: Retrieve similar solved tasks for guidance
