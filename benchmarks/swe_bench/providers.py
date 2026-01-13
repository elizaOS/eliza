"""SWE-bench providers for context injection into ElizaOS runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, ClassVar

from elizaos.types.components import Provider, ProviderResult
from elizaos.types.memory import Memory
from elizaos.types.state import State

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

from .repo_manager import RepositoryManager
from .tools import REPO_MANAGER_KEY
from .types import SWEBenchInstance


# --- Storage for current instance context ---
# This is set by the runner before processing each instance
_current_instance: SWEBenchInstance | None = None


def set_current_instance(instance: SWEBenchInstance | None) -> None:
    """Set the current SWE-bench instance for providers."""
    global _current_instance
    _current_instance = instance


def get_current_instance() -> SWEBenchInstance | None:
    """Get the current SWE-bench instance."""
    return _current_instance


# --- Issue Provider ---


@dataclass
class SWEBenchIssueProvider:
    """Provider that injects the current SWE-bench issue context."""

    name: str = "SWE_BENCH_ISSUE"
    description: str = "Provides the current SWE-bench issue details"
    position: int = 10  # Run early to provide core context
    private: bool = False

    async def get(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> ProviderResult:
        instance = get_current_instance()
        if not instance:
            return ProviderResult(text="", values={}, data={})

        # Build the issue context
        sections = [
            "# SWE-bench Issue",
            f"**Instance ID**: {instance.instance_id}",
            f"**Repository**: {instance.repo}",
            f"**Base Commit**: {instance.base_commit[:12]}",
            "",
            "## Problem Statement",
            instance.problem_statement,
        ]

        if instance.hints_text:
            sections.extend(["", "## Hints", instance.hints_text])

        return ProviderResult(
            text="\n".join(sections),
            values={
                "instance_id": instance.instance_id,
                "repo": instance.repo,
                "base_commit": instance.base_commit,
            },
            data={
                "instance_id": instance.instance_id,
                "repo": instance.repo,
                "base_commit": instance.base_commit,
                "problem_statement": instance.problem_statement,
                "hints_text": instance.hints_text,
            },
        )


swe_bench_issue_provider = Provider(
    name=SWEBenchIssueProvider.name,
    description=SWEBenchIssueProvider.description,
    position=SWEBenchIssueProvider.position,
    private=SWEBenchIssueProvider.private,
    get=SWEBenchIssueProvider().get,
)


# --- Tools Provider ---


@dataclass
class SWEBenchToolsProvider:
    """Provider that describes available SWE-bench tools."""

    name: str = "SWE_BENCH_TOOLS"
    description: str = "Provides descriptions of available SWE-bench tools"
    position: int = 20  # Run after issue provider
    private: bool = False

    async def get(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> ProviderResult:
        tools_text = """# Available Tools

You have access to these tools to investigate and fix the issue:

## SEARCH_CODE
Search for patterns in the codebase.
- Use to find relevant code, function definitions, class usages
- Parameters:
  - `query` (required): The text or pattern to search for
  - `file_pattern` (optional): File pattern to filter (default: *.py)

## READ_FILE
Read file contents.
- Use to examine specific files
- Parameters:
  - `file_path` (required): Path to the file
  - `start_line` (optional): Starting line number (1-indexed)
  - `end_line` (optional): Ending line number (1-indexed)

## EDIT_FILE
Make changes to files.
- Use to fix the issue by modifying code
- Parameters:
  - `file_path` (required): Path to the file to edit
  - `old_content` (required): The exact content to replace (must match exactly)
  - `new_content` (required): The new content to insert

## LIST_FILES
Browse repository structure.
- Use to understand the codebase organization
- Parameters:
  - `directory` (optional): Directory to list (default: repository root)
  - `pattern` (optional): File pattern to filter (e.g., '*.py')

## SUBMIT
Submit your solution.
- Use when you've made all necessary changes
- This generates a patch from your changes
- No parameters required
"""
        return ProviderResult(
            text=tools_text,
            values={"available_tools": ["SEARCH_CODE", "READ_FILE", "EDIT_FILE", "LIST_FILES", "SUBMIT"]},
            data={"tools": ["SEARCH_CODE", "READ_FILE", "EDIT_FILE", "LIST_FILES", "SUBMIT"]},
        )


swe_bench_tools_provider = Provider(
    name=SWEBenchToolsProvider.name,
    description=SWEBenchToolsProvider.description,
    position=SWEBenchToolsProvider.position,
    private=SWEBenchToolsProvider.private,
    get=SWEBenchToolsProvider().get,
)


# --- Repository Structure Provider ---


@dataclass
class SWEBenchRepoStructureProvider:
    """Provider that shows the repository file structure."""

    name: str = "SWE_BENCH_REPO_STRUCTURE"
    description: str = "Provides the repository file structure"
    position: int = 30
    private: bool = False

    async def get(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> ProviderResult:
        # Get repo manager from runtime
        service = runtime.get_service(REPO_MANAGER_KEY)
        if service is None:
            return ProviderResult(text="", values={}, data={})

        manager = getattr(service, "manager", None)
        if not isinstance(manager, RepositoryManager):
            return ProviderResult(text="", values={}, data={})

        if not manager.current_repo:
            return ProviderResult(text="", values={}, data={})

        # Get file tree (limited for context)
        try:
            files = await manager.get_file_tree()
            python_files = [f for f in files if f.endswith(".py")]

            # Show structure
            sections = [
                "# Repository Structure",
                f"Total files: {len(files)}",
                f"Python files: {len(python_files)}",
                "",
                "## Key Python Files (first 50)",
            ]

            for f in python_files[:50]:
                sections.append(f"- {f}")

            if len(python_files) > 50:
                sections.append(f"... and {len(python_files) - 50} more")

            return ProviderResult(
                text="\n".join(sections),
                values={
                    "total_files": len(files),
                    "python_files": len(python_files),
                },
                data={
                    "files": files[:100],
                    "python_files": python_files[:100],
                },
            )
        except Exception:
            return ProviderResult(text="", values={}, data={})


swe_bench_repo_structure_provider = Provider(
    name=SWEBenchRepoStructureProvider.name,
    description=SWEBenchRepoStructureProvider.description,
    position=SWEBenchRepoStructureProvider.position,
    private=SWEBenchRepoStructureProvider.private,
    get=SWEBenchRepoStructureProvider().get,
)


# --- Strategy Provider ---


@dataclass
class SWEBenchStrategyProvider:
    """Provider that provides the problem-solving strategy."""

    name: str = "SWE_BENCH_STRATEGY"
    description: str = "Provides the recommended problem-solving strategy"
    position: int = 40
    private: bool = False

    async def get(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> ProviderResult:
        strategy_text = """# Problem-Solving Strategy

1. **Understand**: Read the issue carefully. What is the bug or feature request?
2. **Locate**: Use SEARCH_CODE to find relevant code. Find where the issue occurs.
3. **Analyze**: Use READ_FILE to examine the relevant files. Understand the code structure.
4. **Fix**: Use EDIT_FILE to make minimal, targeted changes to resolve the issue.
5. **Verify**: Ensure your changes are correct and complete.
6. **Submit**: When confident, use SUBMIT to generate your patch.

## Important Guidelines
- Make minimal changes - only modify what's necessary
- Preserve existing code style and conventions
- Don't add unnecessary features or refactoring
- Ensure backward compatibility
- Consider edge cases
"""
        return ProviderResult(
            text=strategy_text,
            values={},
            data={"strategy_steps": ["understand", "locate", "analyze", "fix", "verify", "submit"]},
        )


swe_bench_strategy_provider = Provider(
    name=SWEBenchStrategyProvider.name,
    description=SWEBenchStrategyProvider.description,
    position=SWEBenchStrategyProvider.position,
    private=SWEBenchStrategyProvider.private,
    get=SWEBenchStrategyProvider().get,
)


# --- Action Results Provider ---


@dataclass
class SWEBenchActionResultsProvider:
    """Provider that shows recent action results."""

    name: str = "SWE_BENCH_ACTION_RESULTS"
    description: str = "Provides recent action results for context"
    position: int = 50
    private: bool = False

    # Store action results externally (set by agent)
    _results: ClassVar[list[dict[str, str]]] = []

    @classmethod
    def add_result(cls, action: str, result: str) -> None:
        """Add an action result to the history."""
        cls._results.append({"action": action, "result": result})
        # Keep only last 5 results
        if len(cls._results) > 5:
            cls._results = cls._results[-5:]

    @classmethod
    def clear_results(cls) -> None:
        """Clear action results."""
        cls._results = []

    async def get(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> ProviderResult:
        if not self._results:
            return ProviderResult(text="", values={}, data={})

        sections = ["# Recent Action Results", ""]
        for i, r in enumerate(self._results):
            sections.append(f"## Action {i + 1}: {r['action']}")
            sections.append(f"```\n{r['result'][:2000]}\n```")
            sections.append("")

        return ProviderResult(
            text="\n".join(sections),
            values={"action_count": len(self._results)},
            data={"results": self._results},
        )


swe_bench_action_results_provider = Provider(
    name=SWEBenchActionResultsProvider.name,
    description=SWEBenchActionResultsProvider.description,
    position=SWEBenchActionResultsProvider.position,
    private=SWEBenchActionResultsProvider.private,
    get=SWEBenchActionResultsProvider().get,
)


# Export all providers
SWE_BENCH_PROVIDERS = [
    swe_bench_issue_provider,
    swe_bench_tools_provider,
    swe_bench_repo_structure_provider,
    swe_bench_strategy_provider,
    swe_bench_action_results_provider,
]

__all__ = [
    "SWE_BENCH_PROVIDERS",
    "swe_bench_issue_provider",
    "swe_bench_tools_provider",
    "swe_bench_repo_structure_provider",
    "swe_bench_strategy_provider",
    "swe_bench_action_results_provider",
    "set_current_instance",
    "get_current_instance",
    "SWEBenchActionResultsProvider",
]
