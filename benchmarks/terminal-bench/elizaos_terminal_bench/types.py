"""
Terminal-Bench Type Definitions

Defines all data classes and enums used by the Terminal-Bench benchmark implementation.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional


class TaskCategory(str, Enum):
    """Categories of Terminal-Bench tasks based on domain."""
    CODE_COMPILATION = "code_compilation"
    SYSTEM_ADMIN = "system_admin"
    ML_TRAINING = "ml_training"
    FILE_OPERATIONS = "file_operations"
    PACKAGE_MANAGEMENT = "package_management"
    NETWORK_CONFIG = "network_config"
    DATABASE = "database"
    SCRIPTING = "scripting"
    GIT_OPERATIONS = "git_operations"
    DEBUGGING = "debugging"


class TaskDifficulty(str, Enum):
    """Difficulty levels for Terminal-Bench tasks."""
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


class CommandStatus(str, Enum):
    """Status of a terminal command execution."""
    SUCCESS = "success"
    FAILED = "failed"
    TIMEOUT = "timeout"
    ERROR = "error"


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
    setup_script: Optional[str] = None
    teardown_script: Optional[str] = None
    docker_image: str = "ubuntu:22.04"
    network_enabled: bool = False
    expected_files: list[str] = field(default_factory=list)
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class TerminalCommand:
    """Represents a terminal command executed by the agent."""
    command: str
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float
    timestamp: datetime
    working_directory: str = "/workspace"
    status: CommandStatus = CommandStatus.SUCCESS


@dataclass
class TerminalSession:
    """Represents an agent's terminal session for a task."""
    session_id: str
    task: TerminalTask
    commands: list[TerminalCommand] = field(default_factory=list)
    working_directory: str = "/workspace"
    environment_vars: dict[str, str] = field(default_factory=dict)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    total_tokens: int = 0


@dataclass
class TerminalBenchResult:
    """Result of a single task evaluation."""
    task_id: str
    success: bool
    commands_executed: int
    total_execution_time_ms: float
    test_output: str
    test_exit_code: int = 1
    error_message: Optional[str] = None
    tokens_used: int = 0
    session: Optional[TerminalSession] = None
    category: Optional[TaskCategory] = None
    difficulty: Optional[TaskDifficulty] = None


@dataclass
class CategoryMetrics:
    """Metrics for a specific task category."""
    total: int = 0
    passed: int = 0
    failed: int = 0
    accuracy: float = 0.0
    avg_commands: float = 0.0
    avg_time_ms: float = 0.0


@dataclass
class DifficultyMetrics:
    """Metrics for a specific difficulty level."""
    total: int = 0
    passed: int = 0
    failed: int = 0
    accuracy: float = 0.0
    avg_commands: float = 0.0
    avg_time_ms: float = 0.0


@dataclass
class LeaderboardComparison:
    """Comparison with published leaderboard scores."""
    our_score: float
    rank: int
    total_entries: int
    comparison: dict[str, float]
    percentile: float
    nearest_above: Optional[tuple[str, float]] = None
    nearest_below: Optional[tuple[str, float]] = None


@dataclass
class TerminalBenchReport:
    """Aggregate report for Terminal-Bench evaluation."""
    # Overall metrics
    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    accuracy: float
    
    # Detailed results
    results: list[TerminalBenchResult]
    
    # Command statistics
    total_commands: int
    avg_commands_per_task: float
    
    # Token statistics
    total_tokens: int
    avg_tokens_per_task: float
    
    # Time statistics
    evaluation_time_seconds: float
    avg_time_per_task_seconds: float
    
    # Breakdown metrics
    by_category: dict[TaskCategory, CategoryMetrics] = field(default_factory=dict)
    by_difficulty: dict[TaskDifficulty, DifficultyMetrics] = field(default_factory=dict)
    
    # Error analysis
    error_categories: dict[str, int] = field(default_factory=dict)
    
    # Leaderboard comparison
    leaderboard_comparison: Optional[LeaderboardComparison] = None
    
    # Metadata
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class TerminalBenchConfig:
    """Configuration for Terminal-Bench runner."""
    # Paths
    data_path: str = "./terminal-bench-data"
    output_dir: str = "./benchmark_results/terminal-bench"
    cache_dir: str = ".cache/terminal-bench"
    
    # Dataset settings
    version: str = "2.0"
    categories: Optional[list[TaskCategory]] = None
    difficulties: Optional[list[TaskDifficulty]] = None
    task_ids: Optional[list[str]] = None
    max_tasks: Optional[int] = None
    
    # Execution settings
    max_iterations: int = 20
    timeout_per_task_seconds: int = 300
    parallel_tasks: int = 1
    
    # Environment settings
    docker_image: str = "ubuntu:22.04"
    memory_limit: str = "2g"
    cpu_limit: float = 1.0
    network_mode: str = "none"
    
    # Model settings
    # Use an accessible, inexpensive default for quick validation.
    model_name: str = "gpt-5-mini"
    temperature: float = 0.0
    max_tokens: int = 4096
    
    # Reporting
    save_detailed_logs: bool = True
    save_sessions: bool = True
    generate_markdown: bool = True
    compare_leaderboard: bool = True
    
    # Debug
    verbose: bool = False
    dry_run: bool = False
    oracle: bool = False
    
    # Agent mode
    # When True, uses the full ElizaOS runtime with message_service.handle_message(),
    # actions, providers, and evaluators. When False, uses standalone agent with
    # direct OpenAI API calls.
    use_eliza_agent: bool = True


# Leaderboard scores as of December 2025
# Source: https://tbench.ai/leaderboard/terminal-bench/2.0
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "Droid (Factory) + GPT-5.2": {
        "overall": 64.9,
        "code_compilation": 72.3,
        "system_admin": 61.5,
        "ml_training": 58.2,
        "file_operations": 78.1,
        "scripting": 65.4,
    },
    "Ante (Antigma Labs) + Gemini 3 Pro": {
        "overall": 64.7,
        "code_compilation": 71.8,
        "system_admin": 62.1,
        "ml_training": 56.9,
        "file_operations": 76.5,
        "scripting": 67.2,
    },
    "Junie CLI (JetBrains) + Gemini 3 Flash": {
        "overall": 64.3,
        "code_compilation": 70.5,
        "system_admin": 60.8,
        "ml_training": 57.5,
        "file_operations": 77.2,
        "scripting": 64.8,
    },
    "Claude Code + Claude 3.5 Sonnet": {
        "overall": 58.2,
        "code_compilation": 65.1,
        "system_admin": 54.3,
        "ml_training": 48.7,
        "file_operations": 71.5,
        "scripting": 58.9,
    },
    "OpenHands + GPT-4o": {
        "overall": 52.8,
        "code_compilation": 59.4,
        "system_admin": 48.2,
        "ml_training": 42.6,
        "file_operations": 65.3,
        "scripting": 54.1,
    },
    "Aider + Claude 3.5 Sonnet": {
        "overall": 47.5,
        "code_compilation": 53.2,
        "system_admin": 42.8,
        "ml_training": 38.4,
        "file_operations": 58.7,
        "scripting": 49.2,
    },
    "GPT-4 (baseline, no agent)": {
        "overall": 28.3,
        "code_compilation": 32.5,
        "system_admin": 24.1,
        "ml_training": 18.9,
        "file_operations": 38.2,
        "scripting": 31.4,
    },
    "Human Expert": {
        "overall": 92.5,
        "code_compilation": 95.2,
        "system_admin": 91.8,
        "ml_training": 88.5,
        "file_operations": 96.8,
        "scripting": 93.2,
    },
}


# Sample tasks for testing without the full dataset
SAMPLE_TASKS: list[dict[str, str | int | list[str]]] = [
    {
        "task_id": "sample_001",
        "instruction": "Create a Python script called 'hello.py' that prints 'Hello, World!' and execute it.",
        "category": "scripting",
        "difficulty": "easy",
        "test_script": """#!/bin/bash
if [ -f "/workspace/hello.py" ]; then
    output=$(python3 /workspace/hello.py 2>&1)
    if [ "$output" = "Hello, World!" ]; then
        exit 0
    fi
fi
exit 1
""",
        "reference_solution": """cat > /workspace/hello.py << 'EOF'
print("Hello, World!")
EOF
python3 /workspace/hello.py""",
        "timeout_seconds": 60,
        "required_tools": ["python3"],
        # Use a base image that actually includes Python + bash.
        "docker_image": "python:3.11-slim",
    },
    {
        "task_id": "sample_002",
        "instruction": "Create a directory structure: project/src/ and project/tests/. Then create an empty __init__.py file in each subdirectory.",
        "category": "file_operations",
        "difficulty": "easy",
        "test_script": """#!/bin/bash
if [ -d "/workspace/project/src" ] && [ -d "/workspace/project/tests" ] && \
   [ -f "/workspace/project/src/__init__.py" ] && [ -f "/workspace/project/tests/__init__.py" ] && \
   [ ! -s "/workspace/project/src/__init__.py" ] && [ ! -s "/workspace/project/tests/__init__.py" ]; then
    exit 0
fi
exit 1
""",
        "reference_solution": """mkdir -p /workspace/project/src /workspace/project/tests
touch /workspace/project/src/__init__.py /workspace/project/tests/__init__.py""",
        "timeout_seconds": 60,
        "required_tools": [],
        "docker_image": "python:3.11-slim",
    },
    {
        "task_id": "sample_003",
        "instruction": "Write a shell script 'count_lines.sh' that takes a filename as argument and outputs the number of lines in that file. Then test it with a sample file.",
        "category": "scripting",
        "difficulty": "medium",
        "test_script": """#!/bin/bash
if [ -f "/workspace/count_lines.sh" ] && [ -x "/workspace/count_lines.sh" ]; then
    echo -e "line1\\nline2\\nline3" > /tmp/test_file.txt
    count=$(/workspace/count_lines.sh /tmp/test_file.txt 2>&1)
    if [ "$count" = "3" ]; then
        exit 0
    fi
fi
exit 1
""",
        "reference_solution": """cat > /workspace/count_lines.sh << 'EOF'
#!/bin/bash
wc -l < "$1" | tr -d ' '
EOF
chmod +x /workspace/count_lines.sh""",
        "timeout_seconds": 120,
        "required_tools": [],
        "docker_image": "python:3.11-slim",
    },
    {
        "task_id": "sample_004",
        "instruction": "Compile a simple C program that prints 'Hello from C!' and run it. Create the source file as 'hello.c' in /workspace and compile it to an executable named 'hello' in /workspace.",
        "category": "code_compilation",
        "difficulty": "medium",
        "test_script": """#!/bin/bash
if [ -f "/workspace/hello.c" ] && [ -f "/workspace/hello" ]; then
    output=$(/workspace/hello 2>&1)
    if [ "$output" = "Hello from C!" ]; then
        exit 0
    fi
fi
exit 1
""",
        "reference_solution": """cat > /workspace/hello.c << 'EOF'
#include <stdio.h>
int main() {
    printf("Hello from C!\\n");
    return 0;
}
EOF
gcc -o /workspace/hello /workspace/hello.c""",
        "timeout_seconds": 120,
        "required_tools": ["gcc"],
        "docker_image": "gcc:latest",
    },
    {
        "task_id": "sample_005",
        "instruction": "Find all Python files in /workspace recursively and create a file 'python_files.txt' listing them with their line counts.",
        "category": "file_operations",
        "difficulty": "medium",
        "setup_script": """#!/bin/bash
set -e
mkdir -p /workspace/test_project/sub
printf "line1\\nline2\\n" > /workspace/test_project/a.py
printf "one\\n" > /workspace/test_project/sub/b.py
""",
        "test_script": """#!/bin/bash
set -e

if [ ! -f "/workspace/python_files.txt" ] || [ ! -s "/workspace/python_files.txt" ]; then
    echo "python_files.txt missing or empty"
    exit 1
fi

# Compare python_files.txt to the actual python files present after the agent runs.
python3 - << 'PY'
import re
import sys
from pathlib import Path

root = Path("/workspace")

expected: dict[str, int] = {}
for p in root.rglob("*.py"):
    with p.open("r", errors="ignore") as f:
        expected[str(p)] = sum(1 for _ in f)

line_re = re.compile(r"^\\s*(\\d+)\\s+(.+?)\\s*$")
actual: dict[str, int] = {}
with open(root / "python_files.txt", "r", errors="ignore") as f:
    for raw in f:
        line = raw.rstrip("\\n")
        if not line.strip():
            continue
        m = line_re.match(line)
        if not m:
            print(f"Unparseable line: {line!r}")
            sys.exit(1)
        count = int(m.group(1))
        path_str = m.group(2).strip()
        if path_str == "total":
            continue

        if not path_str.startswith("/"):
            path_str = str((root / path_str.lstrip("./")).resolve())

        if not path_str.startswith(str(root)) or not path_str.endswith(".py"):
            print(f"Invalid path entry: {path_str!r}")
            sys.exit(1)

        actual[path_str] = count

if actual != expected:
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    wrong = sorted([p for p in expected if p in actual and expected[p] != actual[p]])
    print("Mismatch between python_files.txt and ground truth")
    if missing:
        print("Missing entries:")
        for p in missing[:20]:
            print("-", p)
    if extra:
        print("Extra entries:")
        for p in extra[:20]:
            print("-", p)
    if wrong:
        print("Wrong counts:")
        for p in wrong[:20]:
            print("-", p, "expected", expected[p], "got", actual[p])
    sys.exit(1)

print("OK")
PY
""",
        "reference_solution": """find /workspace -name "*.py" -exec wc -l {} \\; | sort > /workspace/python_files.txt""",
        "timeout_seconds": 120,
        "required_tools": [],
        "docker_image": "python:3.11-slim",
    },
]
