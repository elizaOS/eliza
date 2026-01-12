"""ElizaOS plugin for SWE-bench benchmark."""

from __future__ import annotations

from typing import ClassVar

from elizaos.types.plugin import Plugin
from elizaos.types.runtime import IAgentRuntime
from elizaos.types.service import Service

from .repo_manager import RepositoryManager
from .tools import (
    REPO_MANAGER_KEY,
    SWE_BENCH_ACTIONS,
)


class RepoManagerService(Service):
    """Service wrapper for repository manager."""

    service_type: ClassVar[str] = REPO_MANAGER_KEY
    _workspace_dir: ClassVar[str] = "./swe-bench-workspace"

    def __init__(self, manager: RepositoryManager):
        super().__init__()
        self.manager = manager

    @property
    def capability_description(self) -> str:
        """Description of the service capability."""
        return "Repository manager for SWE-bench code navigation and editing"

    @classmethod
    def set_workspace_dir(cls, workspace_dir: str) -> None:
        """Set the workspace directory before starting the service."""
        cls._workspace_dir = workspace_dir

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> RepoManagerService:
        """Start the repository manager service."""
        _ = runtime  # Unused but required by interface
        manager = RepositoryManager(cls._workspace_dir)
        return cls(manager)

    async def stop(self) -> None:
        """Stop and cleanup."""
        # Don't cleanup by default to preserve state
        pass


def create_swe_bench_plugin(
    workspace_dir: str = "./swe-bench-workspace",
) -> Plugin:
    """Create SWE-bench plugin with custom workspace directory.
    
    Args:
        workspace_dir: Directory for cloning repositories.
        
    Returns:
        Configured SWE-bench plugin.
    """
    # Configure the service class with the workspace directory
    RepoManagerService.set_workspace_dir(workspace_dir)

    return Plugin(
        name="swe-bench",
        description="SWE-bench software engineering benchmark tools for code navigation and editing",
        actions=SWE_BENCH_ACTIONS,
        providers=[],
        services=[RepoManagerService],
    )


# Default plugin instance
swe_bench_plugin = Plugin(
    name="swe-bench",
    description="SWE-bench software engineering benchmark tools for code navigation and editing",
    actions=SWE_BENCH_ACTIONS,
    providers=[],
    services=[RepoManagerService],
)
