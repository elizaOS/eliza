"""
Agent Skills Service

Core service for discovering, loading, and managing Agent Skills.
Implements the Agent Skills specification with Otto compatibility.

See: https://agentskills.io/specification
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional
from zipfile import ZipFile
from io import BytesIO

import httpx

from .types import (
    Skill,
    SkillCatalogEntry,
    SkillDetails,
    SkillFrontmatter,
    SkillInstructions,
    SkillMetadataEntry,
    SkillSearchResult,
)
from .parser import (
    parse_frontmatter,
    validate_frontmatter,
    extract_body,
    estimate_tokens,
    generate_skills_xml,
)

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

# ============================================================
# CONSTANTS
# ============================================================

CLAWHUB_API = "https://clawhub.ai"

CACHE_TTL = {
    "CATALOG": 60 * 60 * 1000,  # 1 hour
    "SKILL_DETAILS": 30 * 60 * 1000,  # 30 min
    "SEARCH": 5 * 60 * 1000,  # 5 min
}

MAX_PACKAGE_SIZE = 10 * 1024 * 1024  # 10MB


# ============================================================
# SERVICE
# ============================================================


class AgentSkillsService:
    """
    Agent Skills Service

    Manages skill discovery, loading, validation, and registry integration.
    Supports both local filesystem skills and ClawHub registry.
    """

    service_type = "AGENT_SKILLS_SERVICE"
    capability_description = "Agent Skills - discover, load, and execute modular agent capabilities"

    def __init__(self, runtime: "IAgentRuntime"):
        self.runtime = runtime
        self.logger = getattr(runtime, "logger", None)

        self.skills_dir = (
            runtime.get_setting("SKILLS_DIR")
            or runtime.get_setting("CLAWHUB_SKILLS_DIR")
            or "./skills"
        )
        self.cache_dir = os.path.join(self.skills_dir, ".cache")
        self.api_base = (
            runtime.get_setting("SKILLS_REGISTRY")
            or runtime.get_setting("CLAWHUB_REGISTRY")
            or CLAWHUB_API
        )

        # In-memory caches
        self._loaded_skills: Dict[str, Skill] = {}
        self._catalog_cache: Optional[Dict] = None
        self._search_cache: Dict[str, Dict] = {}
        self._details_cache: Dict[str, Dict] = {}

        self._http_client = httpx.AsyncClient(timeout=30.0)

    async def initialize(self) -> None:
        """Initialize the service."""
        self._log_info("Service initializing...")

        # Ensure directories exist
        for dir_path in [self.skills_dir, self.cache_dir]:
            Path(dir_path).mkdir(parents=True, exist_ok=True)

        # Load installed skills
        auto_load = self.runtime.get_setting("SKILLS_AUTO_LOAD") != "false"
        if auto_load:
            await self.load_installed_skills()

        # Load cached catalog
        self._load_catalog_from_disk()

        self._log_info(f"Initialized with {len(self._loaded_skills)} installed skills")

    async def stop(self) -> None:
        """Stop the service."""
        self._log_info("Service stopping...")
        self._loaded_skills.clear()
        self._catalog_cache = None
        self._search_cache.clear()
        self._details_cache.clear()
        await self._http_client.aclose()

    # ============================================================
    # SKILL DISCOVERY (Progressive Disclosure Level 1)
    # ============================================================

    def get_skills_metadata(self) -> List[SkillMetadataEntry]:
        """Get skill metadata for all loaded skills."""
        return [
            SkillMetadataEntry(
                name=skill.name,
                description=skill.description,
                location=os.path.join(skill.path, "SKILL.md"),
            )
            for skill in self._loaded_skills.values()
        ]

    def generate_skills_prompt_xml(
        self, include_location: bool = True, max_skills: Optional[int] = None
    ) -> str:
        """Generate XML for available skills (for system prompts)."""
        metadata = self.get_skills_metadata()
        if max_skills:
            metadata = metadata[:max_skills]

        return generate_skills_xml(
            [
                {
                    "name": m.name,
                    "description": m.description,
                    "location": m.location if include_location else "",
                }
                for m in metadata
            ],
            include_location=include_location,
        )

    # ============================================================
    # SKILL LOADING (Progressive Disclosure Level 2)
    # ============================================================

    async def load_installed_skills(self) -> None:
        """Load all installed skills from disk."""
        if not os.path.exists(self.skills_dir):
            return

        for entry in os.scandir(self.skills_dir):
            if entry.is_dir() and not entry.name.startswith("."):
                try:
                    await self.load_skill(entry.name)
                except Exception as e:
                    self._log_warn(f"Failed to load {entry.name}: {e}")

    async def load_skill(
        self, slug_or_path: str, validate: bool = True
    ) -> Optional[Skill]:
        """Load a single skill from disk."""
        # Determine if it's a path or slug
        if os.path.isabs(slug_or_path) or "/" in slug_or_path:
            skill_dir = slug_or_path
            slug = os.path.basename(skill_dir)
        else:
            slug = self._sanitize_slug(slug_or_path)
            skill_dir = os.path.join(self.skills_dir, slug)

        skill_md_path = os.path.join(skill_dir, "SKILL.md")

        if not os.path.exists(skill_md_path):
            return None

        try:
            with open(skill_md_path, "r", encoding="utf-8") as f:
                content = f.read()

            frontmatter, body, _ = parse_frontmatter(content)

            if not frontmatter:
                self._log_warn(f"{slug} has invalid frontmatter")
                return None

            # Validate if requested
            if validate:
                validation = validate_frontmatter(frontmatter, slug)
                if not validation.valid:
                    errors = ", ".join(e.message for e in validation.errors)
                    self._log_warn(f"{slug} validation failed: {errors}")
                for warning in validation.warnings:
                    self._log_debug(f"{slug} warning: {warning.message}")

            # Collect resource files
            scripts = self._list_dir_files(os.path.join(skill_dir, "scripts"))
            references = self._list_dir_files(os.path.join(skill_dir, "references"))
            assets = self._list_dir_files(os.path.join(skill_dir, "assets"))

            # Get version
            version = self._get_skill_version(slug, frontmatter)

            skill = Skill(
                slug=slug,
                name=frontmatter.name,
                description=frontmatter.description,
                version=version,
                content=content,
                frontmatter=frontmatter,
                path=skill_dir,
                scripts=scripts,
                references=references,
                assets=assets,
                loaded_at=int(time.time() * 1000),
            )

            self._loaded_skills[slug] = skill
            return skill
        except Exception as e:
            self._log_error(f"Load error for {slug}: {e}")
            return None

    def get_skill_instructions(self, slug: str) -> Optional[SkillInstructions]:
        """Get skill instructions (body without frontmatter)."""
        try:
            skill = self._loaded_skills.get(self._sanitize_slug(slug))
            if not skill:
                return None

            body = extract_body(skill.content)
            return SkillInstructions(
                slug=skill.slug,
                body=body,
                estimated_tokens=estimate_tokens(body),
            )
        except Exception:
            return None

    # ============================================================
    # RESOURCE ACCESS (Progressive Disclosure Level 3)
    # ============================================================

    def read_reference(self, slug: str, filename: str) -> Optional[str]:
        """Read a reference file from a skill."""
        try:
            skill = self._loaded_skills.get(self._sanitize_slug(slug))
            if not skill:
                return None

            safe_name = os.path.basename(filename)
            file_path = os.path.join(skill.path, "references", safe_name)

            if not os.path.exists(file_path):
                return None

            with open(file_path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    def get_script_path(self, slug: str, filename: str) -> Optional[str]:
        """Get the path to a script file."""
        try:
            skill = self._loaded_skills.get(self._sanitize_slug(slug))
            if not skill:
                return None

            safe_name = os.path.basename(filename)
            file_path = os.path.join(skill.path, "scripts", safe_name)

            return file_path if os.path.exists(file_path) else None
        except Exception:
            return None

    def get_asset_path(self, slug: str, filename: str) -> Optional[str]:
        """Get the path to an asset file."""
        try:
            skill = self._loaded_skills.get(self._sanitize_slug(slug))
            if not skill:
                return None

            safe_name = os.path.basename(filename)
            file_path = os.path.join(skill.path, "assets", safe_name)

            return file_path if os.path.exists(file_path) else None
        except Exception:
            return None

    # ============================================================
    # SKILL RETRIEVAL
    # ============================================================

    def get_loaded_skills(self) -> List[Skill]:
        """Get all loaded skills."""
        return list(self._loaded_skills.values())

    def get_loaded_skill(self, slug: str) -> Optional[Skill]:
        """Get a specific loaded skill."""
        try:
            return self._loaded_skills.get(self._sanitize_slug(slug))
        except Exception:
            return None

    def is_installed(self, slug: str) -> bool:
        """Check if a skill is installed."""
        try:
            return self._sanitize_slug(slug) in self._loaded_skills
        except Exception:
            return False

    # ============================================================
    # REGISTRY OPERATIONS
    # ============================================================

    async def get_catalog(
        self, not_older_than: Optional[int] = None, force_refresh: bool = False
    ) -> List[SkillCatalogEntry]:
        """Get the full skill catalog from the registry."""
        ttl = not_older_than if not_older_than is not None else CACHE_TTL["CATALOG"]

        # Check cache
        if not force_refresh and self._catalog_cache:
            age = int(time.time() * 1000) - self._catalog_cache.get("cached_at", 0)
            if age < ttl:
                return self._catalog_cache.get("data", [])

        # Fetch from API
        try:
            entries: List[SkillCatalogEntry] = []
            cursor: Optional[str] = None

            while True:
                url = f"{self.api_base}/api/v1/skills?limit=100"
                if cursor:
                    url += f"&cursor={cursor}"

                response = await self._http_client.get(
                    url, headers={"Accept": "application/json"}
                )
                response.raise_for_status()

                data = response.json()
                for item in data.get("items", []):
                    entries.append(
                        SkillCatalogEntry(
                            slug=item.get("slug", ""),
                            display_name=item.get("displayName", ""),
                            summary=item.get("summary"),
                            version=item.get("version", ""),
                            tags=item.get("tags", {}),
                            stats=item.get("stats", {}),
                            updated_at=item.get("updatedAt", 0),
                        )
                    )

                cursor = data.get("nextCursor")
                if not cursor:
                    break

            self._catalog_cache = {
                "data": entries,
                "cached_at": int(time.time() * 1000),
            }
            self._save_catalog_to_disk()

            return entries
        except Exception as e:
            self._log_error(f"Catalog fetch error: {e}")
            return self._catalog_cache.get("data", []) if self._catalog_cache else []

    async def search(
        self,
        query: str,
        limit: int = 10,
        not_older_than: Optional[int] = None,
        force_refresh: bool = False,
    ) -> List[SkillSearchResult]:
        """Search the registry for skills."""
        cache_key = f"{query}:{limit}"
        ttl = not_older_than if not_older_than is not None else CACHE_TTL["SEARCH"]

        # Check cache
        if not force_refresh and cache_key in self._search_cache:
            cached = self._search_cache[cache_key]
            if int(time.time() * 1000) - cached.get("cached_at", 0) < ttl:
                return cached.get("data", [])

        try:
            url = f"{self.api_base}/api/v1/search?q={query}&limit={limit}"
            response = await self._http_client.get(
                url, headers={"Accept": "application/json"}
            )
            response.raise_for_status()

            data = response.json()
            results = [
                SkillSearchResult(
                    score=item.get("score", 0),
                    slug=item.get("slug", ""),
                    display_name=item.get("displayName", ""),
                    summary=item.get("summary", ""),
                    version=item.get("version", ""),
                    updated_at=item.get("updatedAt", 0),
                )
                for item in data.get("results", [])
            ]

            self._search_cache[cache_key] = {
                "data": results,
                "cached_at": int(time.time() * 1000),
            }

            return results
        except Exception as e:
            self._log_error(f"Search error: {e}")
            cached = self._search_cache.get(cache_key)
            return cached.get("data", []) if cached else []

    async def get_skill_details(
        self,
        slug: str,
        not_older_than: Optional[int] = None,
        force_refresh: bool = False,
    ) -> Optional[SkillDetails]:
        """Get skill details from the registry."""
        safe_slug = self._sanitize_slug(slug)
        ttl = not_older_than if not_older_than is not None else CACHE_TTL["SKILL_DETAILS"]

        # Check cache
        if not force_refresh and safe_slug in self._details_cache:
            cached = self._details_cache[safe_slug]
            if int(time.time() * 1000) - cached.get("cached_at", 0) < ttl:
                return cached.get("data")

        try:
            url = f"{self.api_base}/api/v1/skills/{safe_slug}"
            response = await self._http_client.get(
                url, headers={"Accept": "application/json"}
            )

            if response.status_code == 404:
                return None

            response.raise_for_status()
            data = response.json()

            skill_data = data.get("skill", {})
            version_data = data.get("latestVersion", {})
            owner_data = data.get("owner", {})

            details = SkillDetails(
                slug=skill_data.get("slug", ""),
                display_name=skill_data.get("displayName", ""),
                summary=skill_data.get("summary", ""),
                tags=skill_data.get("tags", {}),
                stats=skill_data.get("stats", {}),
                created_at=skill_data.get("createdAt", 0),
                updated_at=skill_data.get("updatedAt", 0),
                latest_version=version_data.get("version", ""),
                latest_version_created_at=version_data.get("createdAt", 0),
                changelog=version_data.get("changelog"),
                owner_handle=owner_data.get("handle") if owner_data else None,
                owner_display_name=owner_data.get("displayName") if owner_data else None,
            )

            self._details_cache[safe_slug] = {
                "data": details,
                "cached_at": int(time.time() * 1000),
            }

            return details
        except Exception as e:
            self._log_error(f"Details fetch error: {e}")
            cached = self._details_cache.get(safe_slug)
            return cached.get("data") if cached else None

    # ============================================================
    # INSTALLATION
    # ============================================================

    async def install(
        self, slug: str, version: str = "latest", force: bool = False
    ) -> bool:
        """Install a skill from the registry."""
        try:
            safe_slug = self._sanitize_slug(slug)

            # Check if already installed
            if not force and self.is_installed(safe_slug):
                self._log_info(f"{safe_slug} already installed")
                return True

            self._log_info(f"Installing {safe_slug}@{version}...")

            # Get skill details
            details = await self.get_skill_details(safe_slug)
            if not details:
                raise ValueError(f'Skill "{safe_slug}" not found')

            resolved_version = (
                details.latest_version if version == "latest" else version
            )

            # Download
            download_url = f"{self.api_base}/api/v1/download?slug={safe_slug}&version={resolved_version}"
            response = await self._http_client.get(download_url)
            response.raise_for_status()

            if len(response.content) > MAX_PACKAGE_SIZE:
                raise ValueError(
                    f"Package too large (max {MAX_PACKAGE_SIZE // 1024 // 1024}MB)"
                )

            # Extract
            skill_dir = os.path.join(self.skills_dir, safe_slug)
            Path(skill_dir).mkdir(parents=True, exist_ok=True)

            with ZipFile(BytesIO(response.content)) as zf:
                for member in zf.namelist():
                    # Skip directories
                    if member.endswith("/"):
                        continue

                    # Sanitize path
                    parts = [p for p in member.split("/") if p and p not in ("..", ".")]
                    if not parts:
                        continue

                    safe_path = os.path.join(skill_dir, *parts)
                    Path(os.path.dirname(safe_path)).mkdir(parents=True, exist_ok=True)

                    with zf.open(member) as src, open(safe_path, "wb") as dst:
                        dst.write(src.read())

            # Update lockfile
            self._update_lockfile(safe_slug, resolved_version)

            # Load the skill
            await self.load_skill(safe_slug)

            self._log_info(f"Installed {safe_slug}@{resolved_version}")
            return True
        except Exception as e:
            self._log_error(f"Install error: {e}")
            return False

    # ============================================================
    # SYNC OPERATIONS
    # ============================================================

    async def sync_catalog(self) -> Dict[str, int]:
        """Sync the skill catalog from the registry."""
        old_count = len(self._catalog_cache.get("data", [])) if self._catalog_cache else 0
        await self.get_catalog(force_refresh=True)
        new_count = len(self._catalog_cache.get("data", [])) if self._catalog_cache else 0

        return {
            "added": max(0, new_count - old_count),
            "updated": new_count,
        }

    def get_catalog_stats(self) -> Dict:
        """Get catalog stats for logging."""
        categories = set()
        if self._catalog_cache and self._catalog_cache.get("data"):
            for skill in self._catalog_cache["data"]:
                for tag in skill.tags.keys():
                    if tag != "latest":
                        categories.add(tag)

        return {
            "total": len(self._catalog_cache.get("data", [])) if self._catalog_cache else 0,
            "installed": len(self._loaded_skills),
            "cached_at": self._catalog_cache.get("cached_at") if self._catalog_cache else None,
            "categories": list(categories)[:20],
        }

    # ============================================================
    # PRIVATE HELPERS
    # ============================================================

    def _sanitize_slug(self, slug: str) -> str:
        """Validate and sanitize a skill slug."""
        sanitized = re.sub(r"[^a-zA-Z0-9_-]", "", slug)
        if sanitized != slug or not sanitized or len(sanitized) > 100:
            raise ValueError(f"Invalid skill slug: {slug}")
        return sanitized

    def _list_dir_files(self, dir_path: str) -> List[str]:
        """List files in a directory."""
        if not os.path.exists(dir_path):
            return []
        return [f for f in os.listdir(dir_path) if not f.startswith(".")]

    def _get_skill_version(
        self, slug: str, frontmatter: SkillFrontmatter
    ) -> str:
        """Get skill version from metadata or lockfile."""
        if frontmatter.metadata and frontmatter.metadata.version:
            return frontmatter.metadata.version

        lockfile_version = self._get_lockfile_version(slug)
        return lockfile_version if lockfile_version else "local"

    def _get_lockfile_version(self, slug: str) -> Optional[str]:
        """Get version from lockfile."""
        lockfile_path = os.path.join(self.cache_dir, "lock.json")
        if not os.path.exists(lockfile_path):
            return None

        try:
            with open(lockfile_path, "r") as f:
                lockfile = json.load(f)
            return lockfile.get(slug, {}).get("version")
        except Exception:
            return None

    def _update_lockfile(self, slug: str, version: str) -> None:
        """Update the lockfile with installed version."""
        lockfile_path = os.path.join(self.cache_dir, "lock.json")

        lockfile = {}
        if os.path.exists(lockfile_path):
            try:
                with open(lockfile_path, "r") as f:
                    lockfile = json.load(f)
            except Exception:
                pass

        lockfile[slug] = {
            "version": version,
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

        with open(lockfile_path, "w") as f:
            json.dump(lockfile, f, indent=2)

    def _load_catalog_from_disk(self) -> None:
        """Load cached catalog from disk."""
        catalog_path = os.path.join(self.cache_dir, "catalog.json")
        if not os.path.exists(catalog_path):
            return

        try:
            with open(catalog_path, "r") as f:
                cached = json.load(f)
            if cached.get("data") and cached.get("cached_at"):
                # Convert dict entries to SkillCatalogEntry
                entries = [
                    SkillCatalogEntry(
                        slug=item.get("slug", ""),
                        display_name=item.get("display_name", item.get("displayName", "")),
                        summary=item.get("summary"),
                        version=item.get("version", ""),
                        tags=item.get("tags", {}),
                        stats=item.get("stats", {}),
                        updated_at=item.get("updated_at", item.get("updatedAt", 0)),
                    )
                    for item in cached["data"]
                ]
                self._catalog_cache = {
                    "data": entries,
                    "cached_at": cached["cached_at"],
                }
                self._log_debug(f"Loaded catalog cache ({len(entries)} skills)")
        except Exception:
            pass

    def _save_catalog_to_disk(self) -> None:
        """Save catalog to disk."""
        if not self._catalog_cache:
            return

        catalog_path = os.path.join(self.cache_dir, "catalog.json")
        try:
            # Convert SkillCatalogEntry to dict
            data = [
                {
                    "slug": e.slug,
                    "displayName": e.display_name,
                    "summary": e.summary,
                    "version": e.version,
                    "tags": e.tags,
                    "stats": e.stats,
                    "updatedAt": e.updated_at,
                }
                for e in self._catalog_cache.get("data", [])
            ]
            with open(catalog_path, "w") as f:
                json.dump(
                    {"data": data, "cached_at": self._catalog_cache.get("cached_at")},
                    f,
                    indent=2,
                )
        except Exception:
            pass

    def _log_info(self, message: str) -> None:
        if self.logger:
            self.logger.info(f"AgentSkills: {message}")

    def _log_warn(self, message: str) -> None:
        if self.logger:
            self.logger.warn(f"AgentSkills: {message}")

    def _log_error(self, message: str) -> None:
        if self.logger:
            self.logger.error(f"AgentSkills: {message}")

    def _log_debug(self, message: str) -> None:
        if self.logger:
            self.logger.debug(f"AgentSkills: {message}")
