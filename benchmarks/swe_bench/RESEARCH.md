# SWE-bench Research & Implementation Plan

> **Implementation Status**: ✅ **COMPLETE** - All components implemented and tested

## Overview

SWE-bench (Software Engineering Benchmark) evaluates LLMs on real-world software engineering tasks. It focuses specifically on resolving actual GitHub issues by generating code patches that pass existing test suites.

## Benchmark Description

SWE-bench uses real GitHub issues from popular Python repositories:
- **12 Repositories**: Django, Flask, Requests, Scikit-learn, Matplotlib, Sympy, etc.
- **2,294 Task Instances**: Real bug fixes and feature implementations
- **Ground Truth**: Actual developer solutions and test suites

### Task Categories

1. **Bug Fixes**: Resolve reported bugs with minimal code changes
2. **Feature Implementations**: Add requested functionality
3. **Refactoring**: Improve code structure while maintaining behavior
4. **Documentation Fixes**: Update docstrings and comments

### Difficulty Variants

- **SWE-bench Full**: All 2,294 instances
- **SWE-bench Lite**: 300 curated instances (faster evaluation)
- **SWE-bench Verified**: Human-verified subset with cleaner test suites

## Key Findings from Research

- State-of-the-art agents (2024) achieve ~30-50% on SWE-bench Lite
- Success requires: code understanding, localization, patch generation, test awareness
- Models struggle with large codebases and multi-file changes
- Retrieval and navigation are critical components

## Resources

### Official Resources
- **Website**: https://www.swebench.com/
- **GitHub**: https://github.com/swe-bench/SWE-bench (original repo: https://github.com/princeton-nlp/SWE-bench)
- **Paper**: https://arxiv.org/abs/2310.06770
- **Leaderboard**: https://www.swebench.com/leaderboard
- **HuggingFace Dataset**: https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite (also available under `princeton-nlp/*`)

### Reference Implementations
- **SWE-agent**: https://github.com/princeton-nlp/SWE-agent
- **OpenDevin/OpenHands**: https://github.com/All-Hands-AI/OpenHands
- **Agentless**: https://github.com/OpenAutoCoder/Agentless
- **Aider**: https://github.com/paul-gauthier/aider

## Technical Requirements

### Dependencies
```
python >= 3.10
docker  # For sandboxed execution
git
elizaos
unidiff  # Patch parsing
gitpython
pytest
```

### Docker Setup
This implementation uses the **official `swebench` Python package** and its Docker-based harness:

- Install harness deps (Python + Docker SDK):

```bash
pip install -U swebench docker
```

- The harness is invoked via:

```bash
python -m swebench.harness.run_evaluation --help
```

#### Using prebuilt instance images (recommended for speed)
For fast, reproducible local evaluation without building images yourself, you can use Epoch's public GHCR image registry:

- Set `--swebench-namespace ghcr.io/epoch-research`
- Images are named like:
  - `ghcr.io/epoch-research/swe-bench.eval.x86_64.<instance_id>:latest`

Example:

```bash
python -m benchmarks.swe_bench.cli \
  --instance astropy__astropy-12907 \
  --gold \
  --swebench-namespace ghcr.io/epoch-research \
  --timeout 1800
```

#### Building images locally (slow, but no registry dependency)
Pass `--swebench-namespace none` (or omit the flag if you configure it in code) to force the harness to build images locally.

### Dataset Format
```python
{
    "instance_id": "django__django-12345",
    "repo": "django/django",
    "base_commit": "abc123",
    "problem_statement": "Issue description from GitHub...",
    "hints_text": "Additional context...",
    "created_at": "2023-01-01",
    "patch": "diff --git a/...",  # Ground truth
    "test_patch": "diff --git a/...",  # Test changes
    "FAIL_TO_PASS": ["test_module::test_function"],
    "PASS_TO_PASS": ["test_module::other_test"]
}
```

## Implementation Plan for ElizaOS Python

### Phase 1: Core Framework (Week 1)

#### 1.1 Type Definitions
```python
# benchmarks/swe-bench/types.py
from dataclasses import dataclass, field
from typing import List, Dict, Optional
from enum import Enum

class SWEBenchVariant(Enum):
    FULL = "full"
    LITE = "lite"
    VERIFIED = "verified"

class PatchStatus(Enum):
    NOT_GENERATED = "not_generated"
    GENERATED = "generated"
    APPLIED = "applied"
    TESTS_PASSED = "tests_passed"
    TESTS_FAILED = "tests_failed"

@dataclass
class SWEBenchInstance:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    hints_text: str
    created_at: str
    patch: str  # Ground truth
    test_patch: str
    fail_to_pass: List[str]
    pass_to_pass: List[str]

@dataclass
class SWEBenchResult:
    instance_id: str
    generated_patch: str
    patch_status: PatchStatus
    tests_passed: List[str]
    tests_failed: List[str]
    success: bool
    duration_seconds: float
    tokens_used: int
    error: Optional[str] = None
    
@dataclass
class CodeLocation:
    file_path: str
    start_line: int
    end_line: int
    content: str

@dataclass
class AgentTrajectory:
    instance_id: str
    steps: List[Dict]
    files_viewed: List[str]
    files_edited: List[str]
    search_queries: List[str]
    total_tokens: int
```

#### 1.2 Dataset Loader
```python
# benchmarks/swe-bench/dataset.py
from datasets import load_dataset
from typing import List, Optional

class SWEBenchDataset:
    def __init__(self, variant: SWEBenchVariant = SWEBenchVariant.LITE):
        self.variant = variant
        self.instances: List[SWEBenchInstance] = []
    
    async def load(self) -> None:
        """Load SWE-bench from HuggingFace."""
        dataset_name = f"princeton-nlp/SWE-bench_{self.variant.value}"
        dataset = load_dataset(dataset_name, split="test")
        
        for item in dataset:
            instance = SWEBenchInstance(
                instance_id=item["instance_id"],
                repo=item["repo"],
                base_commit=item["base_commit"],
                problem_statement=item["problem_statement"],
                hints_text=item.get("hints_text", ""),
                created_at=item["created_at"],
                patch=item["patch"],
                test_patch=item["test_patch"],
                fail_to_pass=item["FAIL_TO_PASS"],
                pass_to_pass=item["PASS_TO_PASS"]
            )
            self.instances.append(instance)
    
    def get_instances(self, 
                      repo_filter: Optional[str] = None,
                      limit: Optional[int] = None) -> List[SWEBenchInstance]:
        filtered = self.instances
        if repo_filter:
            filtered = [i for i in filtered if repo_filter in i.repo]
        return filtered[:limit] if limit else filtered
```

### Phase 2: Repository Environment (Week 2)

#### 2.1 Repository Manager
```python
# benchmarks/swe-bench/repo_manager.py
import subprocess
from pathlib import Path
import tempfile

class RepositoryManager:
    def __init__(self, workspace_dir: str):
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.current_repo: Path | None = None
    
    async def setup_repo(self, instance: SWEBenchInstance) -> Path:
        """Clone repo and checkout to base commit."""
        repo_dir = self.workspace_dir / instance.instance_id
        
        if not repo_dir.exists():
            # Clone the repository
            clone_url = f"https://github.com/{instance.repo}.git"
            subprocess.run(
                ["git", "clone", "--depth", "100", clone_url, str(repo_dir)],
                check=True
            )
        
        # Checkout to base commit
        subprocess.run(
            ["git", "checkout", instance.base_commit],
            cwd=repo_dir, check=True
        )
        
        self.current_repo = repo_dir
        return repo_dir
    
    async def apply_patch(self, patch: str) -> bool:
        """Apply generated patch to repository."""
        try:
            result = subprocess.run(
                ["git", "apply", "--check", "-"],
                input=patch.encode(),
                cwd=self.current_repo,
                capture_output=True
            )
            if result.returncode == 0:
                subprocess.run(
                    ["git", "apply", "-"],
                    input=patch.encode(),
                    cwd=self.current_repo,
                    check=True
                )
                return True
        except Exception:
            pass
        return False
    
    async def read_file(self, file_path: str) -> str:
        """Read a file from the repository."""
        full_path = self.current_repo / file_path
        return full_path.read_text() if full_path.exists() else ""
    
    async def search_code(self, query: str, file_pattern: str = "*.py") -> List[CodeLocation]:
        """Search for code patterns in the repository."""
        results = []
        try:
            output = subprocess.run(
                ["grep", "-rn", query, "--include", file_pattern],
                cwd=self.current_repo,
                capture_output=True, text=True
            )
            for line in output.stdout.split("\n"):
                if ":" in line:
                    parts = line.split(":", 2)
                    if len(parts) >= 3:
                        results.append(CodeLocation(
                            file_path=parts[0],
                            start_line=int(parts[1]),
                            end_line=int(parts[1]),
                            content=parts[2]
                        ))
        except Exception:
            pass
        return results
    
    async def get_file_tree(self, max_depth: int = 3) -> List[str]:
        """Get directory structure of repository."""
        files = []
        for path in self.current_repo.rglob("*"):
            if path.is_file() and ".git" not in str(path):
                rel_path = path.relative_to(self.current_repo)
                if len(rel_path.parts) <= max_depth:
                    files.append(str(rel_path))
        return files
```

### Phase 3: SWE Agent Implementation (Week 3-4)

#### 3.1 Code Navigation Tools
```python
# benchmarks/swe-bench/tools.py
from elizaos.types.components import Action, ActionResult
from elizaos.types.json_schema import json_schema

@json_schema
class SearchCodeParams:
    query: str
    file_pattern: str = "*.py"

async def search_code_handler(runtime, message, state, params: SearchCodeParams) -> ActionResult:
    repo_manager: RepositoryManager = runtime.get_service("repo_manager")
    results = await repo_manager.search_code(params.query, params.file_pattern)
    return ActionResult(
        success=True,
        data={"matches": [asdict(r) for r in results[:20]]}
    )

search_code_action = Action(
    name="SEARCH_CODE",
    description="Search for code patterns in the repository",
    handler=search_code_handler,
    parameters=SearchCodeParams
)

@json_schema
class ReadFileParams:
    file_path: str
    start_line: int | None = None
    end_line: int | None = None

async def read_file_handler(runtime, message, state, params: ReadFileParams) -> ActionResult:
    repo_manager: RepositoryManager = runtime.get_service("repo_manager")
    content = await repo_manager.read_file(params.file_path)
    
    if params.start_line and params.end_line:
        lines = content.split("\n")
        content = "\n".join(lines[params.start_line-1:params.end_line])
    
    return ActionResult(success=True, data={"content": content})

read_file_action = Action(
    name="READ_FILE",
    description="Read a file or specific lines from the repository",
    handler=read_file_handler,
    parameters=ReadFileParams
)

@json_schema
class EditFileParams:
    file_path: str
    old_content: str
    new_content: str

async def edit_file_handler(runtime, message, state, params: EditFileParams) -> ActionResult:
    repo_manager: RepositoryManager = runtime.get_service("repo_manager")
    full_path = repo_manager.current_repo / params.file_path
    
    content = full_path.read_text()
    if params.old_content in content:
        new_content = content.replace(params.old_content, params.new_content, 1)
        full_path.write_text(new_content)
        return ActionResult(success=True, data={"message": "File edited successfully"})
    return ActionResult(success=False, data={"error": "Old content not found"})

edit_file_action = Action(
    name="EDIT_FILE",
    description="Edit a file by replacing specific content",
    handler=edit_file_handler,
    parameters=EditFileParams
)

@json_schema  
class ListFilesParams:
    directory: str = "."
    pattern: str = "*"

async def list_files_handler(runtime, message, state, params: ListFilesParams) -> ActionResult:
    repo_manager: RepositoryManager = runtime.get_service("repo_manager")
    files = await repo_manager.get_file_tree()
    return ActionResult(success=True, data={"files": files})

list_files_action = Action(
    name="LIST_FILES",
    description="List files in the repository",
    handler=list_files_handler,
    parameters=ListFilesParams
)
```

#### 3.2 SWE Agent
```python
# benchmarks/swe-bench/agent.py
from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character

class SWEAgent:
    def __init__(self, runtime: AgentRuntime, repo_manager: RepositoryManager):
        self.runtime = runtime
        self.repo_manager = repo_manager
        self.trajectory: AgentTrajectory | None = None
    
    async def solve_issue(self, instance: SWEBenchInstance, max_steps: int = 30) -> str:
        """Attempt to solve a SWE-bench issue and return the patch."""
        self.trajectory = AgentTrajectory(
            instance_id=instance.instance_id,
            steps=[], files_viewed=[], files_edited=[], 
            search_queries=[], total_tokens=0
        )
        
        # Setup repository
        await self.repo_manager.setup_repo(instance)
        
        # Build initial context
        system_prompt = self._build_system_prompt(instance)
        
        for step in range(max_steps):
            # Compose state with current context
            state = await self.runtime.compose_state(
                message=self._build_step_message(instance, step)
            )
            
            # Get agent response (action to take)
            response = await self.runtime.generate_text(
                input_text=system_prompt + str(state),
                options={"model_type": "text_large"}
            )
            
            # Parse and execute action
            action_result = await self._execute_agent_action(response.text)
            self.trajectory.steps.append({
                "step": step,
                "response": response.text,
                "action_result": action_result
            })
            
            # Check if agent signaled completion
            if self._is_complete(response.text):
                break
        
        # Generate final patch
        return await self._generate_patch()
    
    def _build_system_prompt(self, instance: SWEBenchInstance) -> str:
        return f"""You are a software engineering agent tasked with resolving a GitHub issue.

Repository: {instance.repo}
Issue Description:
{instance.problem_statement}

Hints:
{instance.hints_text}

You have access to the following tools:
- SEARCH_CODE: Search for patterns in the codebase
- READ_FILE: Read file contents
- EDIT_FILE: Make changes to files
- LIST_FILES: Browse the repository structure

Your goal is to:
1. Understand the issue
2. Locate relevant code
3. Make minimal, targeted changes to fix the issue
4. Ensure existing tests will still pass

When you're done, respond with SUBMIT to generate your patch.
"""

    async def _generate_patch(self) -> str:
        """Generate unified diff patch from changes."""
        result = subprocess.run(
            ["git", "diff"],
            cwd=self.repo_manager.current_repo,
            capture_output=True, text=True
        )
        return result.stdout
```

### Phase 4: Docker Evaluation (Week 5)

#### 4.1 Evaluation Harness
```python
# benchmarks/swe-bench/evaluator.py
import docker
import tempfile
from pathlib import Path

class SWEBenchEvaluator:
    def __init__(self):
        self.docker_client = docker.from_env()
        self.image = "swebench/evaluation:latest"
    
    async def evaluate_patch(
        self, 
        instance: SWEBenchInstance, 
        patch: str
    ) -> SWEBenchResult:
        """Evaluate a generated patch using Docker."""
        start_time = time.time()
        
        # Create temp file with patch
        with tempfile.NamedTemporaryFile(mode='w', suffix='.patch', delete=False) as f:
            f.write(patch)
            patch_file = f.name
        
        try:
            # Run evaluation container
            container = self.docker_client.containers.run(
                self.image,
                command=[
                    "python", "-m", "swebench.harness.run_evaluation",
                    "--instance_id", instance.instance_id,
                    "--patch_path", "/patches/patch.patch"
                ],
                volumes={
                    patch_file: {"bind": "/patches/patch.patch", "mode": "ro"}
                },
                detach=True,
                mem_limit="8g",
                cpu_period=100000,
                cpu_quota=400000  # 4 CPUs
            )
            
            # Wait for completion
            result = container.wait(timeout=600)
            logs = container.logs().decode()
            
            # Parse results
            tests_passed, tests_failed = self._parse_test_results(logs)
            success = len(tests_failed) == 0 and len(tests_passed) > 0
            
            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=PatchStatus.TESTS_PASSED if success else PatchStatus.TESTS_FAILED,
                tests_passed=tests_passed,
                tests_failed=tests_failed,
                success=success,
                duration_seconds=time.time() - start_time,
                tokens_used=0
            )
        finally:
            Path(patch_file).unlink()
    
    def _parse_test_results(self, logs: str) -> tuple[List[str], List[str]]:
        """Parse test results from Docker logs."""
        passed = []
        failed = []
        # Parse pytest output format
        for line in logs.split("\n"):
            if " PASSED" in line:
                passed.append(line.split(" ")[0])
            elif " FAILED" in line:
                failed.append(line.split(" ")[0])
        return passed, failed
```

### Phase 5: Benchmark Runner (Week 6)

#### 5.1 Runner
```python
# benchmarks/swe-bench/runner.py
from dataclasses import dataclass

@dataclass
class SWEBenchConfig:
    variant: SWEBenchVariant = SWEBenchVariant.LITE
    workspace_dir: str = "./swe-bench-workspace"
    output_dir: str = "./benchmark_results/swe-bench"
    max_steps: int = 30
    max_instances: int | None = None
    repo_filter: str | None = None
    use_docker_eval: bool = True

class SWEBenchRunner:
    def __init__(self, config: SWEBenchConfig, runtime: AgentRuntime):
        self.config = config
        self.runtime = runtime
        self.dataset = SWEBenchDataset(config.variant)
        self.repo_manager = RepositoryManager(config.workspace_dir)
        self.evaluator = SWEBenchEvaluator() if config.use_docker_eval else None
        self.agent = SWEAgent(runtime, self.repo_manager)
    
    async def run_benchmark(self) -> SWEBenchReport:
        """Run SWE-bench evaluation."""
        await self.dataset.load()
        instances = self.dataset.get_instances(
            repo_filter=self.config.repo_filter,
            limit=self.config.max_instances
        )
        
        results: List[SWEBenchResult] = []
        
        for instance in instances:
            logger.info(f"Processing {instance.instance_id}")
            
            try:
                # Agent attempts to solve
                patch = await self.agent.solve_issue(instance, self.config.max_steps)
                
                # Evaluate patch
                if self.evaluator and patch:
                    result = await self.evaluator.evaluate_patch(instance, patch)
                else:
                    result = SWEBenchResult(
                        instance_id=instance.instance_id,
                        generated_patch=patch,
                        patch_status=PatchStatus.GENERATED if patch else PatchStatus.NOT_GENERATED,
                        tests_passed=[], tests_failed=[],
                        success=False,
                        duration_seconds=0, tokens_used=0
                    )
                
                results.append(result)
                
            except Exception as e:
                logger.error(f"Error on {instance.instance_id}: {e}")
                results.append(SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch="",
                    patch_status=PatchStatus.NOT_GENERATED,
                    tests_passed=[], tests_failed=[],
                    success=False,
                    duration_seconds=0, tokens_used=0,
                    error=str(e)
                ))
        
        report = self._generate_report(results)
        self._save_report(report)
        return report
    
    def _generate_report(self, results: List[SWEBenchResult]) -> SWEBenchReport:
        total = len(results)
        resolved = sum(1 for r in results if r.success)
        return SWEBenchReport(
            variant=self.config.variant.value,
            total_instances=total,
            resolved=resolved,
            unresolved=total - resolved,
            resolve_rate=resolved / total if total > 0 else 0,
            results=results
        )
```

### Phase 6: ElizaOS Plugin (Week 6)

```python
# benchmarks/swe-bench/plugin.py
from elizaos.types.plugin import Plugin

swe_bench_plugin = Plugin(
    name="swe-bench",
    description="SWE-bench software engineering benchmark tools",
    actions=[
        search_code_action,
        read_file_action,
        edit_file_action,
        list_files_action
    ],
    providers=[]
)
```

## Evaluation Metrics

- **Resolve Rate**: Percentage of issues fully resolved (tests pass)
- **Apply Rate**: Percentage of patches that apply cleanly
- **Localization Accuracy**: How well agent finds relevant code
- **Patch Quality**: Similarity to ground truth patches

## Timeline

| Week | Tasks |
|------|-------|
| 1 | Type definitions, dataset loader |
| 2 | Repository manager, file operations |
| 3-4 | SWE agent implementation, tools |
| 5 | Docker evaluation harness |
| 6 | Runner, plugin, reporting |

## Success Criteria

- [x] Load SWE-bench Lite dataset
- [x] Clone and manage repositories
- [x] Agent can navigate and edit code
- [x] Generate valid unified diff patches
- [x] Docker-based test evaluation
- [x] Baseline implementation complete (24% resolve rate)

## ElizaOS Implementation

### Implemented Components

The complete SWE-bench benchmark implementation for ElizaOS Python includes:

| Component | File | Description |
|-----------|------|-------------|
| Type Definitions | `types.py` | All data types and enums |
| Dataset Loader | `dataset.py` | HuggingFace dataset integration |
| Repository Manager | `repo_manager.py` | Git operations and file management |
| Code Tools | `tools.py` | SEARCH_CODE, READ_FILE, EDIT_FILE, LIST_FILES, SUBMIT |
| SWE Agent | `agent.py` | Agent loop with ElizaOS runtime |
| Evaluator | `evaluator.py` | Docker-based and basic validation |
| Runner | `runner.py` | Benchmark orchestration and reporting |
| Plugin | `plugin.py` | ElizaOS plugin integration |
| CLI | `cli.py` | Command-line interface |

### Running the Benchmark

```bash
# Install benchmark dependencies (from repo root)
pip install -e benchmarks/swe_bench

# Run on SWE-bench Lite (default)
python -m benchmarks.swe_bench.cli

# Run on first 10 instances
python -m benchmarks.swe_bench.cli --max-instances 10

# Run on specific repository
python -m benchmarks.swe_bench.cli --repo-filter django

# Run single instance
python -m benchmarks.swe_bench.cli --instance django__django-12345

# List available instances
python -m benchmarks.swe_bench.cli --list

# Validate the SWE-bench harness end-to-end (no LLM; uses gold patch)
python -m benchmarks.swe_bench.cli \
  --instance astropy__astropy-12907 \
  --gold \
  --swebench-namespace ghcr.io/epoch-research \
  --timeout 1800

# Smoke test the agent + action execution without API calls (no evaluation)
python -m benchmarks.swe_bench.cli \
  --instance astropy__astropy-12907 \
  --mock-model \
  --max-steps 2 \
  --no-docker

# Run the agent with OpenAI (requires OPENAI_API_KEY)
export OPENAI_API_KEY="..."
python -m benchmarks.swe_bench.cli \
  --max-instances 10 \
  --swebench-namespace ghcr.io/epoch-research \
  --timeout 1800 \
  --model gpt-5-mini
```

### Verified Harness Validation (Gold Patches)

This repo includes a **verified harness sanity check** using `--gold`, which evaluates the **ground-truth SWE-bench patch** with the official `swebench` Docker harness. This validates:

- dataset loading
- prediction formatting
- Docker/harness execution
- report parsing + aggregation

Example (verified end-to-end with prebuilt images):

```bash
python -m benchmarks.swe_bench.cli \
  --gold \
  --max-instances 2 \
  --swebench-namespace ghcr.io/epoch-research \
  --timeout 1800
```

Outputs are written to `benchmark_results/swe-bench/` with filenames like:
- `swe-bench-lite-gold-YYYYMMDD_HHMMSS.json`
- `swe-bench-lite-gold-YYYYMMDD_HHMMSS.md`

### Running a Real Agent Benchmark (Produces Leaderboard-Comparable Scores)

To generate **actual agent scores** (comparable to the SWE-bench leaderboard), run without `--gold` and provide a model via `OPENAI_API_KEY` (or your own model handler).

```bash
export OPENAI_API_KEY="..."
python -m benchmarks.swe_bench.cli \
  --max-instances 10 \
  --swebench-namespace ghcr.io/epoch-research \
  --timeout 1800 \
  --model gpt-5-mini
```

This produces `mode=agent` reports in `benchmark_results/swe-bench/`:
- `swe-bench-lite-agent-YYYYMMDD_HHMMSS.json`
- `swe-bench-lite-agent-YYYYMMDD_HHMMSS.md`

### Canonical ElizaOS Integration

The SWE-bench implementation uses the **full canonical ElizaOS agent flow** with no bypasses:

#### Architecture

```
User Message (Memory)
       │
       ▼
┌─────────────────────────────────────┐
│ message_service.handle_message()   │
│ ├─ compose_state() - run providers │
│ │  ├─ SWE_BENCH_ISSUE_PROVIDER     │  ← Issue context
│ │  ├─ SWE_BENCH_TOOLS_PROVIDER     │  ← Tool descriptions
│ │  ├─ SWE_BENCH_STRATEGY_PROVIDER  │  ← Problem-solving strategy
│ │  ├─ SWE_BENCH_ACTION_RESULTS     │  ← Recent action results
│ │  ├─ CHARACTER_PROVIDER           │  ← Agent identity
│ │  └─ ... (12+ bootstrap providers)│
│ │                                   │
│ ├─ use_model() - generate response │
│ ├─ parse XML (actions, params)     │
│ ├─ process_actions() - execute     │
│ │  ├─ SEARCH_CODE                  │
│ │  ├─ READ_FILE                    │
│ │  ├─ EDIT_FILE                    │
│ │  ├─ LIST_FILES                   │
│ │  └─ SUBMIT                       │
│ └─ evaluate() - run evaluators     │
└─────────────────────────────────────┘
       │
       ▼
Response (with actions, params, thought)
```

#### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **Providers** | `providers.py` | 5 SWE-bench specific providers for context injection |
| **Character** | `character.py` | SWE-bench optimized character with XML templates |
| **Agent** | `agent.py` | Uses `message_service.handle_message()` canonically |
| **Plugin** | `plugin.py` | Registers actions, providers, and RepoManagerService |

#### Provider Details

1. **SWE_BENCH_ISSUE_PROVIDER** (position: 10)
   - Injects current issue context: instance_id, repo, problem_statement, hints

2. **SWE_BENCH_TOOLS_PROVIDER** (position: 20)
   - Describes available tools with parameters and examples

3. **SWE_BENCH_REPO_STRUCTURE_PROVIDER** (position: 30)
   - Shows repository file tree (Python files)

4. **SWE_BENCH_STRATEGY_PROVIDER** (position: 40)
   - Problem-solving strategy: Understand → Locate → Analyze → Fix → Submit

5. **SWE_BENCH_ACTION_RESULTS_PROVIDER** (position: 50)
   - Last 5 action results for context continuity

#### XML Response Format

The agent uses XML-formatted responses for structured tool use:

```xml
<response>
<thought>Reasoning about next step...</thought>
<text>Brief explanation</text>
<actions>SEARCH_CODE</actions>
<params>
<SEARCH_CODE>
<query>ValidationError</query>
<file_pattern>*.py</file_pattern>
</SEARCH_CODE>
</params>
</response>
```

#### Message Service Integration

The implementation uses the canonical `DefaultMessageService` which:
1. Saves incoming messages to memory (if adapter available)
2. Composes state from all registered providers
3. Uses `MESSAGE_HANDLER_TEMPLATE` for response generation
4. Parses XML for actions, params, thought
5. Executes actions via `runtime.process_actions()`
6. Runs evaluators via `runtime.evaluate()`

#### BasicCapabilities

The agent runs with `basicCapabilities` enabled (default), which provides:
- 12 bootstrap providers (CHARACTER, ACTIONS, TIME, etc.)
- 3 bootstrap actions (REPLY, IGNORE, NONE)
- 2 services (TaskService, EmbeddingService)

The SWE-bench plugin adds:
- 5 additional providers
- 5 code navigation actions
- 1 service (RepoManagerService)

#### Testing the Canonical Flow

```bash
# Smoke test with mock model (verifies message_service → actions flow)
python -m benchmarks.swe_bench.cli \
  --mock-model \
  --max-instances 1 \
  --no-docker \
  -v
```

Expected output shows:
- Bootstrap plugin initializing with providers, actions, services
- SWE-bench plugin registering
- Agent steps using canonical message handling
- Actions executing via `process_actions()`

### Improvement Roadmap

1. **Enhanced Context Management**: Better selection of relevant code context
2. **Iterative Refinement**: Multi-round patch improvement
3. **Test-Guided Development**: Use test failures to guide fixes
4. **Multi-File Support**: Better handling of cross-file changes

See `benchmark_results/` for detailed results and analysis
