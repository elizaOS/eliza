"""
Skill Storage Abstraction

Provides two storage backends:
- MemorySkillStore: For browser/virtual FS environments (skills in memory)
- FileSystemSkillStore: For native environments (skills on disk)

Both implement the same interface for seamless switching.
"""

import os
import zipfile
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .parser import parse_frontmatter, validate_frontmatter


# ============================================================
# STORAGE INTERFACE
# ============================================================


@dataclass
class SkillFile:
    """Skill file representation for in-memory storage."""

    path: str
    content: Union[str, bytes]
    is_text: bool


@dataclass
class SkillPackage:
    """Skill package - all files for a skill."""

    slug: str
    files: Dict[str, SkillFile] = field(default_factory=dict)


class ISkillStorage(ABC):
    """Storage interface for skill management."""

    @property
    @abstractmethod
    def storage_type(self) -> str:
        """Storage type identifier: 'memory' or 'filesystem'."""
        pass

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize storage."""
        pass

    @abstractmethod
    async def list_skills(self) -> List[str]:
        """List all installed skill slugs."""
        pass

    @abstractmethod
    async def has_skill(self, slug: str) -> bool:
        """Check if a skill exists."""
        pass

    @abstractmethod
    async def load_skill_content(self, slug: str) -> Optional[str]:
        """Load a skill's SKILL.md content."""
        pass

    @abstractmethod
    async def load_file(
        self, slug: str, relative_path: str
    ) -> Optional[Union[str, bytes]]:
        """Load a specific file from a skill."""
        pass

    @abstractmethod
    async def list_files(self, slug: str, subdir: Optional[str] = None) -> List[str]:
        """List files in a skill directory."""
        pass

    @abstractmethod
    async def save_skill(self, pkg: SkillPackage) -> None:
        """Save a complete skill package."""
        pass

    @abstractmethod
    async def delete_skill(self, slug: str) -> bool:
        """Delete a skill."""
        pass

    @abstractmethod
    def get_skill_path(self, slug: str) -> str:
        """Get skill directory path (filesystem) or virtual path (memory)."""
        pass


# ============================================================
# MEMORY STORAGE (Browser/Virtual FS)
# ============================================================


class MemorySkillStore(ISkillStorage):
    """
    In-memory skill storage for browser environments.

    Skills are stored entirely in memory, making this suitable for:
    - Browser environments without filesystem access
    - Virtual FS scenarios
    - Testing
    - Ephemeral skill loading
    """

    def __init__(self, base_path: str = "/virtual/skills"):
        self._base_path = base_path
        self._skills: Dict[str, SkillPackage] = {}

    @property
    def storage_type(self) -> str:
        return "memory"

    async def initialize(self) -> None:
        """No-op for memory storage."""
        pass

    async def list_skills(self) -> List[str]:
        return list(self._skills.keys())

    async def has_skill(self, slug: str) -> bool:
        return slug in self._skills

    async def load_skill_content(self, slug: str) -> Optional[str]:
        pkg = self._skills.get(slug)
        if not pkg:
            return None

        skill_md = pkg.files.get("SKILL.md")
        if not skill_md or not skill_md.is_text:
            return None

        return skill_md.content if isinstance(skill_md.content, str) else None

    async def load_file(
        self, slug: str, relative_path: str
    ) -> Optional[Union[str, bytes]]:
        pkg = self._skills.get(slug)
        if not pkg:
            return None

        file = pkg.files.get(relative_path)
        if not file:
            return None

        return file.content

    async def list_files(self, slug: str, subdir: Optional[str] = None) -> List[str]:
        pkg = self._skills.get(slug)
        if not pkg:
            return []

        prefix = f"{subdir}/" if subdir else ""
        files = []

        for path in pkg.files.keys():
            if subdir:
                if path.startswith(prefix) and "/" not in path[len(prefix) :]:
                    files.append(path[len(prefix) :])
            elif "/" not in path:
                files.append(path)

        return files

    async def save_skill(self, pkg: SkillPackage) -> None:
        self._skills[pkg.slug] = pkg

    async def delete_skill(self, slug: str) -> bool:
        if slug in self._skills:
            del self._skills[slug]
            return True
        return False

    def get_skill_path(self, slug: str) -> str:
        return f"{self._base_path}/{slug}"

    async def load_from_content(
        self,
        slug: str,
        skill_md_content: str,
        additional_files: Optional[Dict[str, Union[str, bytes]]] = None,
    ) -> None:
        """Load a skill directly from content (no network/file needed)."""
        files: Dict[str, SkillFile] = {}

        # Add SKILL.md
        files["SKILL.md"] = SkillFile(
            path="SKILL.md",
            content=skill_md_content,
            is_text=True,
        )

        # Add any additional files
        if additional_files:
            for path, content in additional_files.items():
                files[path] = SkillFile(
                    path=path,
                    content=content,
                    is_text=isinstance(content, str),
                )

        await self.save_skill(SkillPackage(slug=slug, files=files))

    async def load_from_zip(self, slug: str, zip_buffer: bytes) -> None:
        """Load a skill from a zip buffer (for registry downloads)."""
        files: Dict[str, SkillFile] = {}

        with zipfile.ZipFile(BytesIO(zip_buffer), "r") as zf:
            for file_name in zf.namelist():
                if file_name.endswith("/"):
                    continue

                # Sanitize path
                parts = [p for p in file_name.split("/") if p and p not in ("..", ".")]
                if not parts:
                    continue

                relative_path = "/".join(parts)
                is_text = _is_text_file(relative_path)

                data = zf.read(file_name)
                content: Union[str, bytes] = (
                    data.decode("utf-8") if is_text else data
                )

                files[relative_path] = SkillFile(
                    path=relative_path,
                    content=content,
                    is_text=is_text,
                )

        await self.save_skill(SkillPackage(slug=slug, files=files))

    def get_package(self, slug: str) -> Optional[SkillPackage]:
        """Get the full skill package (for export/transfer)."""
        return self._skills.get(slug)

    def get_all_packages(self) -> Dict[str, SkillPackage]:
        """Get all skills in memory."""
        return dict(self._skills)


# ============================================================
# FILESYSTEM STORAGE (Native)
# ============================================================


class FileSystemSkillStore(ISkillStorage):
    """
    Filesystem-based skill storage for native environments.

    Skills are stored on disk, making this suitable for:
    - Python server environments
    - CLI tools
    - Persistent skill installations
    """

    def __init__(self, base_path: str = "./skills"):
        self._base_path = Path(base_path)

    @property
    def storage_type(self) -> str:
        return "filesystem"

    async def initialize(self) -> None:
        """Ensure base directory exists."""
        self._base_path.mkdir(parents=True, exist_ok=True)

    async def list_skills(self) -> List[str]:
        if not self._base_path.exists():
            return []

        return [
            d.name
            for d in self._base_path.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        ]

    async def has_skill(self, slug: str) -> bool:
        skill_path = self._base_path / slug / "SKILL.md"
        return skill_path.exists()

    async def load_skill_content(self, slug: str) -> Optional[str]:
        skill_path = self._base_path / slug / "SKILL.md"
        if not skill_path.exists():
            return None

        return skill_path.read_text(encoding="utf-8")

    async def load_file(
        self, slug: str, relative_path: str
    ) -> Optional[Union[str, bytes]]:
        # Sanitize path to prevent directory traversal
        safe_parts = [p for p in relative_path.split("/") if p and p not in ("..", ".")]
        if not safe_parts:
            return None

        full_path = self._base_path / slug / "/".join(safe_parts)
        if not full_path.exists():
            return None

        if _is_text_file(relative_path):
            return full_path.read_text(encoding="utf-8")
        else:
            return full_path.read_bytes()

    async def list_files(self, slug: str, subdir: Optional[str] = None) -> List[str]:
        dir_path = (
            self._base_path / slug / subdir if subdir else self._base_path / slug
        )

        if not dir_path.exists():
            return []

        return [f.name for f in dir_path.iterdir() if not f.name.startswith(".")]

    async def save_skill(self, pkg: SkillPackage) -> None:
        skill_dir = self._base_path / pkg.slug

        # Create skill directory
        skill_dir.mkdir(parents=True, exist_ok=True)

        # Write all files
        for relative_path, file in pkg.files.items():
            full_path = skill_dir / relative_path
            full_path.parent.mkdir(parents=True, exist_ok=True)

            if file.is_text:
                full_path.write_text(str(file.content), encoding="utf-8")
            else:
                full_path.write_bytes(
                    file.content if isinstance(file.content, bytes) else file.content.encode()
                )

    async def delete_skill(self, slug: str) -> bool:
        skill_dir = self._base_path / slug
        if not skill_dir.exists():
            return False

        import shutil

        shutil.rmtree(skill_dir)
        return True

    def get_skill_path(self, slug: str) -> str:
        return str((self._base_path / slug).resolve())

    async def save_from_zip(self, slug: str, zip_buffer: bytes) -> None:
        """Save a skill from a zip buffer."""
        files: Dict[str, SkillFile] = {}

        with zipfile.ZipFile(BytesIO(zip_buffer), "r") as zf:
            for file_name in zf.namelist():
                if file_name.endswith("/"):
                    continue

                parts = [p for p in file_name.split("/") if p and p not in ("..", ".")]
                if not parts:
                    continue

                relative_path = "/".join(parts)
                is_text = _is_text_file(relative_path)

                data = zf.read(file_name)
                content: Union[str, bytes] = (
                    data.decode("utf-8") if is_text else data
                )

                files[relative_path] = SkillFile(
                    path=relative_path,
                    content=content,
                    is_text=is_text,
                )

        await self.save_skill(SkillPackage(slug=slug, files=files))


# ============================================================
# HELPER FUNCTIONS
# ============================================================


def _is_text_file(file_path: str) -> bool:
    """Determine if a file is text-based by extension."""
    text_extensions = {
        ".md",
        ".txt",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".js",
        ".ts",
        ".py",
        ".rs",
        ".sh",
        ".bash",
        ".html",
        ".css",
        ".xml",
        ".svg",
        ".env",
        ".gitignore",
        ".dockerignore",
    }

    ext = Path(file_path).suffix.lower()
    return ext in text_extensions or "." not in Path(file_path).name


def create_storage(
    storage_type: str = "auto",
    base_path: Optional[str] = None,
) -> ISkillStorage:
    """
    Create the appropriate storage based on type.

    Args:
        storage_type: 'memory', 'filesystem', or 'auto'
        base_path: Base path for storage

    Returns:
        ISkillStorage instance
    """
    if storage_type == "memory":
        return MemorySkillStore(base_path or "/virtual/skills")

    if storage_type == "filesystem":
        return FileSystemSkillStore(base_path or "./skills")

    # Auto-detect: In Python we default to filesystem since
    # browser Python runtimes are less common
    return FileSystemSkillStore(base_path or "./skills")


async def install_from_github(
    storage: ISkillStorage,
    repo: str,
    path: Optional[str] = None,
    branch: str = "main",
) -> Optional[Dict]:
    """
    Install a skill from a GitHub repository.

    Supports both full repo paths and shorthand:
    - "owner/repo" - Uses repo root
    - "owner/repo/path/to/skill" - Uses specific subdirectory
    - "https://github.com/owner/repo" - Full URL

    Downloads SKILL.md and any additional files.

    Args:
        storage: Storage instance to save the skill
        repo: Repository identifier (owner/repo or full URL)
        path: Optional path within the repo
        branch: Git branch (default: main)

    Returns:
        Loaded skill dict or None if failed
    """
    import aiohttp
    from urllib.parse import urlparse

    try:
        owner: str
        repo_name: str
        skill_path = path or ""

        # Handle full URL
        if repo.startswith("http"):
            parsed = urlparse(repo)
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) < 2:
                raise ValueError("Invalid GitHub URL")
            owner = parts[0]
            repo_name = parts[1]
            if len(parts) > 2:
                tree_idx = parts.index("tree") if "tree" in parts else -1
                if tree_idx >= 0 and len(parts) > tree_idx + 2:
                    skill_path = "/".join(parts[tree_idx + 2 :])
                elif len(parts) > 2:
                    skill_path = "/".join(parts[2:])
        else:
            # Handle shorthand: owner/repo or owner/repo/path
            parts = repo.split("/")
            if len(parts) < 2:
                raise ValueError("Invalid repo format. Use owner/repo or owner/repo/path")
            owner = parts[0]
            repo_name = parts[1]
            if len(parts) > 2:
                skill_path = "/".join(parts[2:])

        # Derive slug from path or repo name
        slug = skill_path.split("/")[-1] if skill_path else repo_name

        # Construct raw GitHub URLs
        base_path = f"{skill_path}/" if skill_path else ""
        raw_base = f"https://raw.githubusercontent.com/{owner}/{repo_name}/{branch}/{base_path}"

        # Download SKILL.md
        skill_md_url = f"{raw_base}SKILL.md"

        async with aiohttp.ClientSession() as session:
            async with session.get(skill_md_url) as response:
                if response.status != 200:
                    print(f"Failed to fetch SKILL.md from {skill_md_url}: {response.status}")
                    return None
                skill_md_content = await response.text()

            # Try to fetch README.md (optional)
            readme_content: Optional[str] = None
            try:
                async with session.get(f"{raw_base}README.md") as response:
                    if response.status == 200:
                        readme_content = await response.text()
            except Exception:
                pass

        # Create skill package
        files: Dict[str, SkillFile] = {
            "SKILL.md": SkillFile(path="SKILL.md", content=skill_md_content, is_text=True)
        }

        if readme_content:
            files["README.md"] = SkillFile(
                path="README.md", content=readme_content, is_text=True
            )

        # Save to storage
        await storage.save_skill(SkillPackage(slug=slug, files=files))

        # Load and return
        return await load_skill_from_storage(storage, slug)

    except Exception as e:
        print(f"GitHub install error: {e}")
        return None


async def install_from_url(
    storage: ISkillStorage,
    url: str,
    slug: Optional[str] = None,
) -> Optional[Dict]:
    """
    Install a skill from a direct URL to a SKILL.md file or zip package.

    Args:
        storage: Storage instance
        url: URL to SKILL.md or zip file
        slug: Optional skill slug (derived from URL if not provided)

    Returns:
        Loaded skill dict or None if failed
    """
    import aiohttp
    from urllib.parse import urlparse
    import re

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status != 200:
                    print(f"Failed to fetch: {response.status}")
                    return None

                content_type = response.headers.get("content-type", "")

                # Derive slug from URL
                url_path = urlparse(url).path
                derived_slug = slug or re.sub(r"\.(md|zip)$", "", url_path.split("/")[-1]) or "skill"

                if "application/zip" in content_type or url.endswith(".zip"):
                    # Handle zip package
                    zip_buffer = await response.read()

                    if isinstance(storage, MemorySkillStore):
                        await storage.load_from_zip(derived_slug, zip_buffer)
                    elif isinstance(storage, FileSystemSkillStore):
                        await storage.save_from_zip(derived_slug, zip_buffer)
                else:
                    # Assume it's a SKILL.md file
                    content = await response.text()
                    files = {
                        "SKILL.md": SkillFile(
                            path="SKILL.md", content=content, is_text=True
                        )
                    }
                    await storage.save_skill(SkillPackage(slug=derived_slug, files=files))

                return await load_skill_from_storage(storage, derived_slug)

    except Exception as e:
        print(f"URL install error: {e}")
        return None


async def load_skill_from_storage(
    storage: ISkillStorage,
    slug: str,
    validate: bool = True,
) -> Optional[Dict]:
    """
    Load a skill from storage into a Skill dict.

    Args:
        storage: Storage instance
        slug: Skill slug
        validate: Whether to validate frontmatter

    Returns:
        Skill dict or None if not found
    """
    content = await storage.load_skill_content(slug)
    if not content:
        return None

    result = parse_frontmatter(content)
    frontmatter = result.get("frontmatter")
    if not frontmatter:
        return None

    # Validate if requested
    if validate:
        validation = validate_frontmatter(frontmatter, slug)
        if not validation.get("valid"):
            import sys

            print(
                f"Skill {slug} validation failed: {validation.get('errors')}",
                file=sys.stderr,
            )

    # List resource files
    scripts = await storage.list_files(slug, "scripts")
    references = await storage.list_files(slug, "references")
    assets = await storage.list_files(slug, "assets")

    # Get version
    version = "local"
    metadata = frontmatter.get("metadata")
    if metadata and isinstance(metadata, dict):
        version = str(metadata.get("version", "local"))

    import time

    return {
        "slug": slug,
        "name": frontmatter.get("name", slug),
        "description": frontmatter.get("description", ""),
        "version": version,
        "content": content,
        "frontmatter": frontmatter,
        "path": storage.get_skill_path(slug),
        "scripts": scripts,
        "references": references,
        "assets": assets,
        "loaded_at": int(time.time() * 1000),
    }
