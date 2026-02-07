"""Prose service for OpenProse VM operations."""

from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from elizaos_plugin_prose.types import ProseConfig, ProseSkillFile, ProseStateMode

logger = logging.getLogger(__name__)

# Module-level skill content cache
_skill_content: dict[str, str] = {}


def generate_run_id() -> str:
    """Generate a unique run ID in format YYYYMMDD-HHMMSS-random6."""
    now = datetime.now()
    date_str = now.strftime("%Y%m%d")
    time_str = now.strftime("%H%M%S")
    random_part = os.urandom(3).hex()
    return f"{date_str}-{time_str}-{random_part}"


class ProseService:
    """Service for OpenProse VM operations."""

    def __init__(self, config: ProseConfig | None = None) -> None:
        self._config = config or ProseConfig()
        self._skills_dir: Path | None = None
        logger.info("Prose service initialized")

    async def init(self, skills_dir: str | None = None) -> None:
        """Initialize the service by loading skill files."""
        if skills_dir:
            self._skills_dir = Path(skills_dir)
            await self._load_skill_files(self._skills_dir)
        logger.info("Prose service initialization complete")

    async def _load_skill_files(self, base_dir: Path) -> None:
        """Load skill files from a directory."""
        files = [
            "SKILL.md",
            "prose.md",
            "help.md",
            "compiler.md",
            "state/filesystem.md",
            "state/in-context.md",
            "state/sqlite.md",
            "state/postgres.md",
            "guidance/patterns.md",
            "guidance/antipatterns.md",
            "primitives/session.md",
        ]

        for file in files:
            file_path = base_dir / file
            try:
                if file_path.exists():
                    content = file_path.read_text(encoding="utf-8")
                    _skill_content[file] = content
                    logger.debug(f"Loaded skill file: {file}")
            except Exception as e:
                logger.debug(f"Could not load skill file {file}: {e}")

    def get_vm_spec(self) -> str | None:
        """Get the VM specification (prose.md)."""
        return _skill_content.get("prose.md")

    def get_skill_spec(self) -> str | None:
        """Get the skill description (SKILL.md)."""
        return _skill_content.get("SKILL.md")

    def get_help(self) -> str | None:
        """Get the help documentation."""
        return _skill_content.get("help.md")

    def get_compiler_spec(self) -> str | None:
        """Get the compiler/validation spec."""
        return _skill_content.get("compiler.md")

    def get_state_spec(self, mode: ProseStateMode) -> str | None:
        """Get state management spec for a given mode."""
        filename_map = {
            ProseStateMode.FILESYSTEM: "state/filesystem.md",
            ProseStateMode.IN_CONTEXT: "state/in-context.md",
            ProseStateMode.SQLITE: "state/sqlite.md",
            ProseStateMode.POSTGRES: "state/postgres.md",
        }
        filename = filename_map.get(mode)
        return _skill_content.get(filename) if filename else None

    def get_authoring_guidance(self) -> dict[str, str | None]:
        """Get authoring guidance (patterns and antipatterns)."""
        return {
            "patterns": _skill_content.get("guidance/patterns.md"),
            "antipatterns": _skill_content.get("guidance/antipatterns.md"),
        }

    def get_loaded_skills(self) -> list[ProseSkillFile]:
        """Get all loaded skill files."""
        return [
            ProseSkillFile(name=name, path=name, content=content)
            for name, content in _skill_content.items()
        ]

    async def file_exists(self, file_path: str) -> bool:
        """Check if a .prose file exists."""
        return Path(file_path).exists()

    async def read_prose_file(self, file_path: str) -> str:
        """Read a .prose file."""
        return Path(file_path).read_text(encoding="utf-8")

    async def ensure_workspace(self, base_dir: str = ".") -> str:
        """Create the workspace directory structure."""
        workspace_dir = Path(base_dir) / (self._config.workspace_dir or ".prose")
        workspace_dir.mkdir(parents=True, exist_ok=True)
        (workspace_dir / "runs").mkdir(exist_ok=True)
        (workspace_dir / "agents").mkdir(exist_ok=True)
        return str(workspace_dir)

    async def create_run_directory(
        self,
        workspace_dir: str,
        program_content: str,
    ) -> tuple[str, str]:
        """Create a new run directory."""
        run_id = generate_run_id()
        run_dir = Path(workspace_dir) / "runs" / run_id

        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "bindings").mkdir(exist_ok=True)
        (run_dir / "agents").mkdir(exist_ok=True)
        (run_dir / "imports").mkdir(exist_ok=True)

        # Write the program copy
        (run_dir / "program.prose").write_text(program_content, encoding="utf-8")

        # Initialize state.md
        initial_state = f"""# Run State

run_id: {run_id}
status: initializing
position: 0

## Program

```prose
{program_content}
```

## Execution Log

| Time | Position | Action | Status |
|------|----------|--------|--------|
"""
        (run_dir / "state.md").write_text(initial_state, encoding="utf-8")

        return run_id, str(run_dir)

    async def list_examples(self) -> list[str]:
        """List available example programs."""
        if not self._skills_dir:
            return []

        examples_dir = self._skills_dir / "examples"
        if not examples_dir.exists():
            return []

        return sorted(
            f.name for f in examples_dir.iterdir() if f.suffix == ".prose"
        )

    async def read_example(self, name: str) -> str | None:
        """Read an example program."""
        if not self._skills_dir:
            return None

        examples_dir = self._skills_dir / "examples"
        file_name = name if name.endswith(".prose") else f"{name}.prose"
        file_path = examples_dir / file_name

        if not file_path.exists():
            return None

        return file_path.read_text(encoding="utf-8")

    def build_vm_context(
        self,
        state_mode: ProseStateMode = ProseStateMode.FILESYSTEM,
        include_compiler: bool = False,
        include_guidance: bool = False,
    ) -> str:
        """Build the VM context for the agent."""
        parts: list[str] = []

        # VM banner
        parts.append(
            """┌─────────────────────────────────────┐
│         ◇ OpenProse VM ◇            │
│       A new kind of computer        │
└─────────────────────────────────────┘"""
        )

        # Core VM spec
        vm_spec = self.get_vm_spec()
        if vm_spec:
            parts.append("\n## VM Specification\n")
            parts.append(vm_spec)

        # State management spec
        state_spec = self.get_state_spec(state_mode)
        if state_spec:
            parts.append(f"\n## State Management ({state_mode.value})\n")
            parts.append(state_spec)

        # Compiler spec if needed
        if include_compiler:
            compiler_spec = self.get_compiler_spec()
            if compiler_spec:
                parts.append("\n## Compiler/Validator\n")
                parts.append(compiler_spec)

        # Authoring guidance if needed
        if include_guidance:
            guidance = self.get_authoring_guidance()
            if guidance.get("patterns"):
                parts.append("\n## Authoring Patterns\n")
                parts.append(guidance["patterns"])
            if guidance.get("antipatterns"):
                parts.append("\n## Authoring Antipatterns\n")
                parts.append(guidance["antipatterns"])

        return "\n".join(parts)


def set_skill_content(skills: dict[str, str]) -> None:
    """Set embedded skill content (for bundled deployment)."""
    global _skill_content
    _skill_content = skills


def get_skill_content() -> dict[str, str]:
    """Get all skill content."""
    return _skill_content
