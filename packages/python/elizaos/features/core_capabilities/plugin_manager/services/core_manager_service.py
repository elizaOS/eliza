"""Core manager service.

Manages the core elizaOS installation lifecycle: eject (clone upstream
source for local development), sync (pull upstream changes), and
re-inject (revert to npm packages).

Ported from plugin-manager/services/coreManagerService.ts.

The Python port preserves the full API surface but adapts Node.js-specific
patterns (child_process.exec, fs-extra) to asyncio subprocess and pathlib.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
from datetime import UTC
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from elizaos.types import Service

from ..types import UpstreamMetadata

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

logger = logging.getLogger("elizaos.plugin_manager.core_manager")

_CORE_GIT_URL = "https://github.com/elizaos/eliza.git"
_CORE_BRANCH = "develop"
_CORE_PACKAGE_NAME = "@elizaos/core"

_VALID_GIT_URL = re.compile(r"^https://[a-zA-Z0-9][\w./-]*\.git$")
_VALID_BRANCH = re.compile(r"^[a-zA-Z0-9][\w./-]*$")


def _resolve_state_dir() -> Path:
    """Resolve the state directory, respecting env overrides."""
    for var in ("ELIZA_STATE_DIR", "ELIZA_STATE_DIR"):
        val = os.environ.get(var)
        if val:
            return Path(val)
    namespace = os.environ.get("ELIZA_NAMESPACE", "eliza")
    return Path.home() / f".{namespace}"


class CoreEjectResult:
    __slots__ = ("success", "ejected_path", "upstream_commit", "error")

    def __init__(
        self,
        success: bool,
        ejected_path: str,
        upstream_commit: str,
        error: str | None = None,
    ) -> None:
        self.success = success
        self.ejected_path = ejected_path
        self.upstream_commit = upstream_commit
        self.error = error


class CoreSyncResult:
    __slots__ = (
        "success",
        "ejected_path",
        "upstream_commits",
        "local_changes",
        "conflicts",
        "commit_hash",
        "error",
    )

    def __init__(
        self,
        success: bool,
        ejected_path: str,
        upstream_commits: int,
        local_changes: bool,
        conflicts: list[str],
        commit_hash: str,
        error: str | None = None,
    ) -> None:
        self.success = success
        self.ejected_path = ejected_path
        self.upstream_commits = upstream_commits
        self.local_changes = local_changes
        self.conflicts = conflicts
        self.commit_hash = commit_hash
        self.error = error


class CoreReinjectResult:
    __slots__ = ("success", "removed_path", "error")

    def __init__(
        self,
        success: bool,
        removed_path: str,
        error: str | None = None,
    ) -> None:
        self.success = success
        self.removed_path = removed_path
        self.error = error


class CoreStatus:
    __slots__ = (
        "ejected",
        "ejected_path",
        "monorepo_path",
        "core_package_path",
        "core_dist_path",
        "version",
        "npm_version",
        "commit_hash",
        "local_changes",
        "upstream",
    )

    def __init__(
        self,
        ejected: bool,
        ejected_path: str,
        monorepo_path: str,
        core_package_path: str,
        core_dist_path: str,
        version: str,
        npm_version: str,
        commit_hash: str | None,
        local_changes: bool,
        upstream: UpstreamMetadata | None,
    ) -> None:
        self.ejected = ejected
        self.ejected_path = ejected_path
        self.monorepo_path = monorepo_path
        self.core_package_path = core_package_path
        self.core_dist_path = core_dist_path
        self.version = version
        self.npm_version = npm_version
        self.commit_hash = commit_hash
        self.local_changes = local_changes
        self.upstream = upstream


class CoreManagerService(Service):
    """Manages the core elizaOS installation (eject, sync, reinject)."""

    service_type: ClassVar[str] = "core_manager"

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        super().__init__(runtime)
        self._lock = asyncio.Lock()

    @property
    def capability_description(self) -> str:
        return "Manages the core elizaOS installation (eject, sync, reinject)"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> CoreManagerService:
        service = cls(runtime)
        logger.info("[CoreManagerService] Started")
        return service

    async def stop(self) -> None:
        logger.info("[CoreManagerService] Stopped")

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    def _core_base_dir(self) -> Path:
        return _resolve_state_dir() / "core"

    def _core_monorepo_dir(self) -> Path:
        return self._core_base_dir() / "eliza"

    def _core_package_dir(self) -> Path:
        return self._core_monorepo_dir() / "packages" / "core"

    def _core_dist_dir(self) -> Path:
        return self._core_package_dir() / "dist"

    def _upstream_file_path(self) -> Path:
        return self._core_base_dir() / ".upstream.json"

    def _is_within_ejected_core_dir(self, target: Path) -> bool:
        base = self._core_base_dir().resolve()
        resolved = target.resolve()
        if resolved == base:
            return False
        return str(resolved).startswith(str(base) + os.sep)

    # ------------------------------------------------------------------
    # Git helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _git_stdout(args: list[str], cwd: str | None = None) -> str:
        cmd = ["git"] + args
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode().strip()

    @staticmethod
    async def _run_cmd(cmd: str, cwd: str | None = None) -> None:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"Command failed ({proc.returncode}): {cmd}\n{stderr.decode()}")

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    async def _read_core_package_version(
        self,
        package_dir: Path | None = None,
    ) -> str:
        pkg_dir = package_dir or self._core_package_dir()
        pkg_json = pkg_dir / "package.json"
        try:
            data = json.loads(pkg_json.read_text())
            ver = data.get("version", "")
            if isinstance(ver, str) and ver.strip():
                return ver.strip()
        except Exception:
            pass
        return "unknown"

    async def _resolve_installed_core_version(self) -> str:
        """Best-effort resolution of the installed @elizaos/core version."""
        try:
            core_pkg = Path.cwd() / "node_modules" / "@elizaos" / "core" / "package.json"
            if core_pkg.exists():
                data = json.loads(core_pkg.read_text())
                return data.get("version", "unknown")
        except Exception:
            pass
        return "unknown"

    async def _read_upstream_metadata(self) -> UpstreamMetadata | None:
        try:
            raw = self._upstream_file_path().read_text()
            data = json.loads(raw)
            if (
                data.get("$schema") != "milaidy-upstream-v1"
                or not isinstance(data.get("gitUrl"), str)
                or not isinstance(data.get("branch"), str)
                or not isinstance(data.get("commitHash"), str)
                or not isinstance(data.get("npmPackage"), str)
                or not isinstance(data.get("npmVersion"), str)
            ):
                return None
            return UpstreamMetadata(
                schema="milaidy-upstream-v1",
                source=data.get("source", "github:elizaos/eliza"),
                git_url=data["gitUrl"],
                branch=data["branch"],
                commit_hash=data["commitHash"],
                ejected_at=data.get("ejectedAt", ""),
                npm_package=data["npmPackage"],
                npm_version=data["npmVersion"],
                last_sync_at=data.get("lastSyncAt"),
                local_commits=data.get("localCommits", 0),
            )
        except Exception:
            return None

    async def _write_upstream_metadata(self, metadata: UpstreamMetadata) -> None:
        self._core_base_dir().mkdir(parents=True, exist_ok=True)
        payload = {
            "$schema": metadata.schema,
            "source": metadata.source,
            "gitUrl": metadata.git_url,
            "branch": metadata.branch,
            "commitHash": metadata.commit_hash,
            "ejectedAt": metadata.ejected_at,
            "npmPackage": metadata.npm_package,
            "npmVersion": metadata.npm_version,
            "lastSyncAt": metadata.last_sync_at,
            "localCommits": metadata.local_commits,
        }
        self._upstream_file_path().write_text(json.dumps(payload, indent=2))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def eject_core(self) -> CoreEjectResult:
        async with self._lock:
            npm_version = await self._resolve_installed_core_version()

            if not _VALID_GIT_URL.match(_CORE_GIT_URL):
                return CoreEjectResult(False, "", "", f'Invalid git URL: "{_CORE_GIT_URL}"')
            if not _VALID_BRANCH.match(_CORE_BRANCH):
                return CoreEjectResult(False, "", "", f'Invalid git branch: "{_CORE_BRANCH}"')

            base = self._core_base_dir()
            base.mkdir(parents=True, exist_ok=True)

            monorepo = self._core_monorepo_dir()
            if not self._is_within_ejected_core_dir(monorepo):
                return CoreEjectResult(
                    False, str(monorepo), "", f"Refusing to write outside {base}"
                )

            if monorepo.exists():
                return CoreEjectResult(
                    False,
                    str(monorepo),
                    "",
                    f"{_CORE_PACKAGE_NAME} is already ejected at {monorepo}",
                )

            logger.info("Cloning %s from %s ...", _CORE_PACKAGE_NAME, _CORE_GIT_URL)
            try:
                await self._run_cmd(
                    f"git clone --branch {_CORE_BRANCH} --single-branch --depth 1 "
                    f"{_CORE_GIT_URL} {monorepo}"
                )
            except RuntimeError as exc:
                return CoreEjectResult(False, str(monorepo), "", str(exc))

            try:
                commit_hash = await self._git_stdout(["rev-parse", "HEAD"], str(monorepo))
                from datetime import datetime

                metadata = UpstreamMetadata(
                    schema="milaidy-upstream-v1",
                    source="github:elizaos/eliza",
                    git_url=_CORE_GIT_URL,
                    branch=_CORE_BRANCH,
                    commit_hash=commit_hash,
                    ejected_at=datetime.now(UTC).isoformat(),
                    npm_package=_CORE_PACKAGE_NAME,
                    npm_version=npm_version,
                    last_sync_at=None,
                    local_commits=0,
                )
                await self._write_upstream_metadata(metadata)
                logger.info("Successfully ejected %s to %s", _CORE_PACKAGE_NAME, monorepo)
                return CoreEjectResult(True, str(monorepo), commit_hash)
            except Exception as exc:
                logger.error("Failed to eject core: %s", exc)
                if monorepo.exists():
                    shutil.rmtree(monorepo, ignore_errors=True)
                up_file = self._upstream_file_path()
                if up_file.exists():
                    up_file.unlink(missing_ok=True)
                return CoreEjectResult(False, str(monorepo), "", str(exc))

    async def sync_core(self) -> CoreSyncResult:
        async with self._lock:
            monorepo = self._core_monorepo_dir()
            if not monorepo.exists():
                return CoreSyncResult(
                    False,
                    "",
                    0,
                    False,
                    [],
                    "",
                    f"{_CORE_PACKAGE_NAME} is not ejected",
                )
            if not self._is_within_ejected_core_dir(monorepo):
                return CoreSyncResult(
                    False,
                    str(monorepo),
                    0,
                    False,
                    [],
                    "",
                    f"Refusing to use core checkout outside {self._core_base_dir()}",
                )

            upstream = await self._read_upstream_metadata()
            if upstream is None:
                return CoreSyncResult(
                    False,
                    str(monorepo),
                    0,
                    False,
                    [],
                    "",
                    f"Missing or invalid {self._upstream_file_path()}",
                )

            if not _VALID_GIT_URL.match(upstream.git_url) or not _VALID_BRANCH.match(
                upstream.branch
            ):
                return CoreSyncResult(
                    False,
                    str(monorepo),
                    0,
                    False,
                    [],
                    "",
                    "Invalid upstream metadata",
                )

            cwd = str(monorepo)

            # Unshallow if needed
            try:
                is_shallow = await self._git_stdout(["rev-parse", "--is-shallow-repository"], cwd)
                if is_shallow == "true":
                    with contextlib.suppress(Exception):
                        await self._run_cmd(
                            f"git fetch --unshallow origin {upstream.branch}",
                            cwd,
                        )
            except Exception:
                pass

            await self._run_cmd(f"git fetch origin {upstream.branch}", cwd)

            # Detect local changes
            porcelain = ""
            with contextlib.suppress(Exception):
                porcelain = await self._git_stdout(["status", "--porcelain"], cwd)
            local_changes = len(porcelain) > 0

            # Count upstream commits
            try:
                count_raw = await self._git_stdout(
                    ["rev-list", "--count", f"HEAD..origin/{upstream.branch}"], cwd
                )
                upstream_commits = int(count_raw)
            except Exception:
                upstream_commits = 0

            if upstream_commits > 0:
                try:
                    await self._run_cmd(f"git merge --no-edit origin/{upstream.branch}", cwd)
                except Exception as exc:
                    conflicts_raw = ""
                    with contextlib.suppress(Exception):
                        conflicts_raw = await self._git_stdout(
                            ["diff", "--name-only", "--diff-filter=U"], cwd
                        )
                    conflicts = [l.strip() for l in conflicts_raw.splitlines() if l.strip()]
                    return CoreSyncResult(
                        False,
                        cwd,
                        upstream_commits,
                        local_changes,
                        conflicts,
                        "",
                        str(exc),
                    )

            commit_hash = await self._git_stdout(["rev-parse", "HEAD"], cwd)

            from datetime import datetime

            updated = UpstreamMetadata(
                schema=upstream.schema,
                source=upstream.source,
                git_url=upstream.git_url,
                branch=upstream.branch,
                commit_hash=commit_hash,
                ejected_at=upstream.ejected_at,
                npm_package=upstream.npm_package,
                npm_version=upstream.npm_version,
                last_sync_at=datetime.now(UTC).isoformat(),
                local_commits=upstream.local_commits,
            )
            await self._write_upstream_metadata(updated)

            return CoreSyncResult(
                True,
                cwd,
                upstream_commits,
                local_changes,
                [],
                commit_hash,
            )

    async def reinject_core(self) -> CoreReinjectResult:
        async with self._lock:
            monorepo = self._core_monorepo_dir()
            if not monorepo.exists():
                return CoreReinjectResult(False, "", f"{_CORE_PACKAGE_NAME} is not ejected")
            if not self._is_within_ejected_core_dir(monorepo):
                return CoreReinjectResult(
                    False,
                    str(monorepo),
                    f"Refusing to remove core checkout outside {self._core_base_dir()}",
                )

            shutil.rmtree(monorepo, ignore_errors=True)
            up_file = self._upstream_file_path()
            if up_file.exists():
                up_file.unlink(missing_ok=True)

            # Clean up empty parent
            try:
                base = self._core_base_dir()
                if base.exists() and not any(base.iterdir()):
                    base.rmdir()
            except Exception:
                pass

            return CoreReinjectResult(True, str(monorepo))

    async def get_core_status(self) -> CoreStatus:
        monorepo = self._core_monorepo_dir()
        package_dir = self._core_package_dir()
        dist_dir = self._core_dist_dir()
        npm_version = await self._resolve_installed_core_version()
        ejected = monorepo.exists()

        if not ejected or not self._is_within_ejected_core_dir(monorepo):
            return CoreStatus(
                ejected=False,
                ejected_path=str(monorepo),
                monorepo_path=str(monorepo),
                core_package_path=str(package_dir),
                core_dist_path=str(dist_dir),
                version=npm_version,
                npm_version=npm_version,
                commit_hash=None,
                local_changes=False,
                upstream=None,
            )

        version = await self._read_core_package_version(package_dir)
        cwd = str(monorepo)
        try:
            commit_hash: str | None = await self._git_stdout(["rev-parse", "HEAD"], cwd)
        except Exception:
            commit_hash = None

        porcelain = ""
        with contextlib.suppress(Exception):
            porcelain = await self._git_stdout(["status", "--porcelain"], cwd)
        local_changes = len(porcelain) > 0

        return CoreStatus(
            ejected=True,
            ejected_path=str(monorepo),
            monorepo_path=str(monorepo),
            core_package_path=str(package_dir),
            core_dist_path=str(dist_dir),
            version=version,
            npm_version=npm_version,
            commit_hash=commit_hash,
            local_changes=local_changes,
            upstream=await self._read_upstream_metadata(),
        )
