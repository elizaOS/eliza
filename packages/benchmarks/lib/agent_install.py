"""Auto-install + verify OpenClaw and Hermes-agent for the tri-agent harness.

Manages local source checkouts of OpenClaw and the Hermes-agent Python project
under ``$ELIZA_AGENTS_ROOT`` (default ``~/.eliza/agents``).
Each agent has a single ``manifest.json`` recording the resolved version,
install path, binary path, and any extra env vars needed when spawning.

Stdlib only. All subprocess calls capture stdout+stderr and surface them
on failure -- no silent swallowing.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


AGENT_ROOT = Path(os.environ.get("ELIZA_AGENTS_ROOT", Path.home() / ".eliza" / "agents"))

HERMES_GIT_URL = "https://github.com/NousResearch/hermes-agent"
HERMES_DIR_NAME = "hermes-agent-src"
HERMES_VENV_PYTHON = os.environ.get("HERMES_VENV_PYTHON", sys.executable)
OPENCLAW_NPM_PACKAGE = "openclaw"


class AgentInstallError(RuntimeError):
    """Raised when an install or verification step fails."""


@dataclass(frozen=True)
class InstalledAgent:
    """Record describing an installed agent."""

    agent_id: str
    version: str
    install_path: Path
    binary_path: Path
    env: dict[str, str] = field(default_factory=dict)

    def to_dict(self, *, installed_at: str | None = None) -> dict[str, object]:
        data: dict[str, object] = {
            "agent_id": self.agent_id,
            "version": self.version,
            "install_path": str(self.install_path),
            "binary_path": str(self.binary_path),
            "env": dict(self.env),
        }
        if installed_at is not None:
            data["installed_at"] = installed_at
        return data

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> "InstalledAgent":
        return cls(
            agent_id=str(data["agent_id"]),
            version=str(data["version"]),
            install_path=Path(str(data["install_path"])),
            binary_path=Path(str(data["binary_path"])),
            env=dict(data.get("env") or {}),
        )


def _run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    context: str,
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess, capturing stdout+stderr.

    On non-zero exit raises ``AgentInstallError`` with the full output so
    failures surface with context (never silently swallowed).
    """
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd is not None else None,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=int(os.environ.get("AGENT_INSTALL_TIMEOUT_SECONDS", "300")),
        )
    except subprocess.TimeoutExpired as exc:
        raise AgentInstallError(
            f"{context}: command {cmd!r} timed out after {exc.timeout}s"
        ) from exc
    if result.returncode != 0:
        raise AgentInstallError(
            f"{context}: command {cmd!r} exited {result.returncode}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result


def manifest_path(agent_id: str) -> Path:
    return AGENT_ROOT / agent_id / "manifest.json"


def read_manifest(agent_id: str) -> InstalledAgent | None:
    """Read the manifest for ``agent_id``; return ``None`` if absent/invalid."""
    path = manifest_path(agent_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    required = {"agent_id", "version", "install_path", "binary_path"}
    if not required.issubset(data.keys()):
        return None
    try:
        return InstalledAgent.from_dict(data)
    except (KeyError, TypeError, ValueError):
        return None


def write_manifest(installed: InstalledAgent) -> None:
    """Atomically write the manifest for ``installed`` (tmp + rename)."""
    path = manifest_path(installed.agent_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = installed.to_dict(installed_at=datetime.now(timezone.utc).isoformat())
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _clone_or_update_source(
    *,
    repo_dir: Path,
    git_url: str,
    ref: str,
    force: bool,
    context: str,
) -> str:
    if repo_dir.exists() and force:
        shutil.rmtree(repo_dir)
    repo_dir.parent.mkdir(parents=True, exist_ok=True)
    if not repo_dir.exists():
        _run(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--single-branch",
                "--depth",
                "1",
                "-b",
                ref,
                git_url,
                str(repo_dir),
            ],
            context=f"git clone {context} ref={ref}",
        )
    else:
        _run(["git", "fetch", "--depth", "1", "origin", ref], cwd=repo_dir, context=f"git fetch {context}")
        _run(["git", "checkout", "FETCH_HEAD"], cwd=repo_dir, context=f"git checkout {context} ref={ref}")
    head = _run(["git", "rev-parse", "HEAD"], cwd=repo_dir, context=f"git rev-parse {context} HEAD").stdout.strip()
    if not head:
        raise AgentInstallError(f"{context}: git rev-parse HEAD returned empty output")
    return head


def install_openclaw(version: str = "latest", force: bool = False) -> InstalledAgent:
    """Install OpenClaw from npm into ``$ELIZA_AGENTS_ROOT/openclaw/<version>/``.

    The published ``openclaw`` package ships a built binary at
    ``node_modules/.bin/openclaw`` once installed via npm. The source repo
    does not include the ``dist/`` build output, so we install from the
    registry instead of cloning. ``version="latest"`` resolves the current
    published version via ``npm view``.
    """
    if version == "latest":
        view = _run(
            ["npm", "view", OPENCLAW_NPM_PACKAGE, "version"],
            context="npm view openclaw version",
        )
        resolved_version = view.stdout.strip()
        if not resolved_version:
            raise AgentInstallError(
                "npm view openclaw version returned empty output"
            )
    else:
        resolved_version = version

    prefix = AGENT_ROOT / "openclaw" / resolved_version
    binary = prefix / "node_modules" / ".bin" / "openclaw"

    if not force:
        existing = read_manifest("openclaw")
        if (
            existing is not None
            and existing.version == resolved_version
            and existing.binary_path.is_file()
        ):
            return existing

    prefix.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "npm",
            "install",
            "--prefix",
            str(prefix),
            f"{OPENCLAW_NPM_PACKAGE}@{resolved_version}",
        ],
        context=f"npm install openclaw@{resolved_version}",
    )

    if not binary.is_file():
        raise AgentInstallError(
            f"OpenClaw binary not found at {binary} after npm install"
        )

    installed = InstalledAgent(
        agent_id="openclaw",
        version=resolved_version,
        install_path=prefix,
        binary_path=binary,
        env={"OPENCLAW_BIN": str(binary)},
    )
    write_manifest(installed)
    return installed


def install_hermes(ref: str = "main", force: bool = False) -> InstalledAgent:
    """Install Hermes-agent into ``$ELIZA_AGENTS_ROOT/hermes-agent-src``.

    If a clone already exists with a matching manifest and venv python,
    the existing record is returned. Otherwise the directory is removed
    (when ``force`` is set or the manifest is stale) and re-cloned fresh
    at ``ref``.
    """
    repo_dir = AGENT_ROOT / HERMES_DIR_NAME
    venv_python = repo_dir / ".venv" / "bin" / "python"

    existing = read_manifest("hermes")
    if (
        not force
        and existing is not None
        and existing.binary_path == venv_python
        and existing.binary_path.exists()
        and repo_dir.is_dir()
    ):
        # Confirm we're on the recorded ref to avoid silently drifting.
        try:
            rev = _run(
                ["git", "rev-parse", "HEAD"],
                cwd=repo_dir,
                context="git rev-parse HEAD",
            ).stdout.strip()
        except AgentInstallError:
            rev = ""
        if rev and rev == existing.version:
            return existing

    head = _clone_or_update_source(
        repo_dir=repo_dir,
        git_url=HERMES_GIT_URL,
        ref=ref,
        force=force,
        context="hermes-agent",
    )

    _run(
        [HERMES_VENV_PYTHON, "-m", "venv", ".venv"],
        cwd=repo_dir,
        context=f"{HERMES_VENV_PYTHON} -m venv .venv",
    )

    if not venv_python.exists():
        raise AgentInstallError(
            f"Hermes venv python not found at {venv_python} after venv creation"
        )

    _run(
        [str(venv_python), "-m", "pip", "install", "-e", "."],
        cwd=repo_dir,
        context="pip install -e . (hermes-agent)",
    )

    installed = InstalledAgent(
        agent_id="hermes",
        version=head,
        install_path=repo_dir,
        binary_path=venv_python,
        env={},
    )
    write_manifest(installed)
    return installed


def verify_install(agent_id: str) -> tuple[bool, str]:
    """Run a trivial verification command for the installed agent.

    Returns ``(success, diagnostic_message)``. Does not raise on failure
    -- the diagnostic captures stdout/stderr so callers can surface it.
    """
    record = read_manifest(agent_id)
    if record is None:
        return False, f"no manifest found for agent_id={agent_id!r}"
    if not record.binary_path.exists():
        return False, f"binary missing at {record.binary_path}"

    if agent_id == "openclaw":
        cmd = [str(record.binary_path), "--version"]
        cwd: Path | None = record.install_path
        success_check = lambda r: r.returncode == 0 and bool((r.stdout or r.stderr).strip())
    elif agent_id == "hermes":
        cmd = [
            str(record.binary_path),
            "-c",
            "import openai; print('ok')",
        ]
        cwd = record.install_path
        success_check = lambda r: r.returncode == 0 and "ok" in r.stdout
    else:
        return False, f"unknown agent_id={agent_id!r}"

    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd is not None else None,
        capture_output=True,
        text=True,
        check=False,
    )
    if success_check(result):
        return True, result.stdout.strip()
    return False, (
        f"verify {agent_id} failed: exit={result.returncode}\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )


_INSTALLERS = {
    "openclaw": install_openclaw,
    "hermes": install_hermes,
}


def install_all(
    agents: list[str] | None = None,
    *,
    force: bool = False,
) -> dict[str, InstalledAgent]:
    """Install each agent in ``agents`` (default both); return a mapping."""
    if agents is None:
        agents = ["openclaw", "hermes"]
    results: dict[str, InstalledAgent] = {}
    for agent_id in agents:
        installer = _INSTALLERS.get(agent_id)
        if installer is None:
            raise AgentInstallError(f"unknown agent_id={agent_id!r}")
        try:
            results[agent_id] = installer(force=force)
        except AgentInstallError as exc:
            raise AgentInstallError(f"install {agent_id} failed: {exc}") from exc
    return results


def _format_summary(records: dict[str, tuple[InstalledAgent | None, bool, str]]) -> str:
    lines = [f"{'agent':<10} {'version':<14} {'ok':<4} detail"]
    lines.append("-" * 70)
    for agent_id, (record, ok, detail) in records.items():
        version = record.version if record is not None else "-"
        flag = "yes" if ok else "no"
        short = detail.splitlines()[0] if detail else ""
        lines.append(f"{agent_id:<10} {version:<14} {flag:<4} {short}")
    return "\n".join(lines)


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Install and verify tri-agent harness agents (OpenClaw, Hermes)."
    )
    parser.add_argument(
        "--agents",
        default="openclaw,hermes",
        help="Comma-separated list of agent_ids to operate on.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force reinstall even if a manifest already exists.",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Skip install; only run verification against existing manifests.",
    )
    args = parser.parse_args(argv)

    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    if not agents:
        print("no agents specified", file=sys.stderr)
        return 1

    summary: dict[str, tuple[InstalledAgent | None, bool, str]] = {}
    overall_ok = True

    if not args.verify_only:
        try:
            install_all(agents, force=args.force)
        except AgentInstallError as exc:
            print(f"install failed: {exc}", file=sys.stderr)
            overall_ok = False

    for agent_id in agents:
        record = read_manifest(agent_id)
        ok, detail = verify_install(agent_id)
        if not ok:
            overall_ok = False
        summary[agent_id] = (record, ok, detail)

    print(_format_summary(summary))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(cli())
