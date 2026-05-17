"""
Docker-based OpenClaw execution for QwenClawBench.

Each task runs in an isolated Docker container with openclaw pre-installed.
Supports concurrent execution across multiple containers.
"""

import json
import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


DEFAULT_IMAGE = "ghcr.io/openclaw/openclaw:main"

# Set on `docker run` so cleanup can find containers regardless of name pattern.
QWENCLAWBENCH_CONTAINER_LABEL = "qwenclawbench=1"
OPENCLAW_HOME = Path(__file__).parent.parent / "openclaw_config"
CONTAINER_OPENCLAW_HOME = "/home/node/.openclaw"
CONTAINER_WORKSPACE = "/home/node/workspace"
ENV_FILE = OPENCLAW_HOME / ".env"


class DockerContainer:
    """Manages a single Docker container for task execution.

    Each container gets its own isolated copy of ~/.openclaw so that concurrent
    containers don't stomp on each other's agent configs and session files.
    The host env file is passed via --env-file so API keys are available.
    """

    def __init__(
        self,
        container_name: str,
        image: str = DEFAULT_IMAGE,
        env_file: Optional[Path] = None,
        openclaw_home: Optional[Path] = None,
    ):
        self.container_name = container_name
        self.image = image
        self.env_file = env_file or ENV_FILE
        self.openclaw_home = openclaw_home or OPENCLAW_HOME
        self._running = False
        # Per-container isolated openclaw home on the host
        self._local_openclaw_copy: Optional[Path] = None

    def start(self) -> None:
        """Start the Docker container in detached mode.

        Creates a per-container copy of ~/.openclaw so concurrent containers
        each have their own agent store and session directory.
        """
        # Remove existing container with same name if any
        subprocess.run(
            ["docker", "rm", "-f", self.container_name],
            capture_output=True,
            check=False,
        )

        # Create an isolated copy of the openclaw home for this container.
        # We only need the config files (settings, auth), not old agent data.
        self._local_openclaw_copy = Path(f"/tmp/qwenclawbench/docker_homes/{self.container_name}")
        if self._local_openclaw_copy.exists():
            shutil.rmtree(self._local_openclaw_copy)
        self._local_openclaw_copy.mkdir(parents=True, exist_ok=True)

        # Copy config files from the real openclaw home (shallow — skip agents/)
        for item in self.openclaw_home.iterdir():
            if item.name == "agents":
                continue  # will be created fresh inside the container
            if item.name == ".env":
                continue  # injected via --env-file at docker run, no need to copy into container
            dest = self._local_openclaw_copy / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)

        # Container runs as node (uid 1000); host copy is often root-owned. chown so
        # openclaw inside the container can read openclaw.json and write sessions.
        chown_result = subprocess.run(
            ["chown", "-R", "1000:1000", str(self._local_openclaw_copy)],
            capture_output=True,
            text=True,
            check=False,
        )
        if chown_result.returncode != 0:
            logger.warning(
                "chown 1000:1000 on openclaw copy failed (run as root?): %s",
                chown_result.stderr or chown_result.stdout,
            )

        cmd = [
            "docker", "run", "-d",
            "--name", self.container_name,
            "--label", QWENCLAWBENCH_CONTAINER_LABEL,
            "-v", f"{self._local_openclaw_copy}:{CONTAINER_OPENCLAW_HOME}",
        ]
        if self.env_file.exists():
            cmd += ["--env-file", str(self.env_file)]
        cmd.append(self.image)
        # Keep container alive with a long sleep
        cmd += ["sleep", "infinity"]

        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to start container {self.container_name}: {result.stderr}"
            )
        self._running = True
        logger.info("Started container: %s", self.container_name)

        # Wait for container to be ready
        self._wait_ready()

    def _wait_ready(self, timeout: float = 30.0) -> None:
        """Wait until the container is running and responsive."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            result = subprocess.run(
                ["docker", "inspect", "-f", "{{.State.Running}}", self.container_name],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0 and result.stdout.strip() == "true":
                return
            time.sleep(0.5)
        raise RuntimeError(f"Container {self.container_name} did not become ready in {timeout}s")

    def exec(
        self,
        cmd: List[str],
        timeout: Optional[float] = None,
        workdir: Optional[str] = None,
        user: Optional[str] = None,
    ) -> subprocess.CompletedProcess:
        """Execute a command inside the container.

        If ``user`` is set (e.g. ``"0"`` for root), runs as that user via ``docker exec -u``.
        Default is the image USER (often ``node``).
        """
        docker_cmd = ["docker", "exec"]
        if user:
            docker_cmd += ["-u", user]
        if workdir:
            docker_cmd += ["-w", workdir]
        docker_cmd.append(self.container_name)
        docker_cmd.extend(cmd)

        try:
            return subprocess.run(
                docker_cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return subprocess.CompletedProcess(
                args=docker_cmd,
                returncode=-1,
                stdout=exc.stdout or "",
                stderr=f"Command timed out after {timeout}s",
            )

    def copy_to(self, local_path: Path, container_path: str) -> None:
        """Copy a file or directory from host into the container."""
        result = subprocess.run(
            ["docker", "cp", str(local_path), f"{self.container_name}:{container_path}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to copy {local_path} to {self.container_name}:{container_path}: "
                f"{result.stderr}"
            )

    def copy_from(self, container_path: str, local_path: Path) -> None:
        """Copy a file or directory from the container to host."""
        local_path.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["docker", "cp", f"{self.container_name}:{container_path}", str(local_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            logger.warning(
                "Failed to copy %s:%s to %s: %s",
                self.container_name,
                container_path,
                local_path,
                result.stderr,
            )

    def stop(self) -> None:
        """Stop and remove the container, clean up isolated openclaw home."""
        subprocess.run(
            ["docker", "rm", "-f", self.container_name],
            capture_output=True,
            check=False,
        )
        self._running = False
        if self._local_openclaw_copy and self._local_openclaw_copy.exists():
            shutil.rmtree(self._local_openclaw_copy, ignore_errors=True)
        logger.info("Stopped container: %s", self.container_name)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


def prepare_docker_workspace(
    skill_dir: Path,
    task,
    container: DockerContainer,
    asset_dirs: Optional[List[Path]] = None,
) -> str:
    """Prepare workspace files inside the container. Returns the container workspace path."""
    # Create workspace dir inside container
    container.exec(["mkdir", "-p", CONTAINER_WORKSPACE])

    # Asset search directories (in priority order)
    if asset_dirs:
        asset_search_dirs = list(asset_dirs)
    else:
        asset_search_dirs = [
            skill_dir / "assets",
            skill_dir / "generated_assets",
        ]

    for file_spec in task.workspace_files:
        if "content" in file_spec:
            # Write inline content to a temp file, then copy in
            with tempfile.NamedTemporaryFile(mode="w", suffix=".tmp", delete=False) as tmp:
                tmp.write(file_spec["content"])
                tmp_path = Path(tmp.name)
            dest = f"{CONTAINER_WORKSPACE}/{file_spec['path']}"
            # Ensure parent dir exists inside container
            parent = "/".join(dest.split("/")[:-1])
            container.exec(["mkdir", "-p", parent])
            container.copy_to(tmp_path, dest)
            tmp_path.unlink()
            continue

        source_rel = file_spec["source"]
        dest = f"{CONTAINER_WORKSPACE}/{file_spec['dest']}"
        parent = "/".join(dest.split("/")[:-1])
        container.exec(["mkdir", "-p", parent])

        source_found = None
        for asset_dir in asset_search_dirs:
            # Task-specific subfolder takes priority over global path
            for candidate in [
                asset_dir / task.task_id / source_rel,
                asset_dir / source_rel,
            ]:
                if candidate.exists():
                    source_found = candidate
                    break
            if source_found:
                break

        if source_found is None:
            searched = [
                path
                for d in asset_search_dirs
                for path in [str(d / task.task_id / source_rel), str(d / source_rel)]
            ]
            raise FileNotFoundError(
                f"Asset file '{source_rel}' not found in any of: {searched}"
            )

        container.copy_to(source_found, dest)

    chown_result = container.exec(
        ["chown", "-R", "1000:1000", CONTAINER_WORKSPACE],
        user="0",
    )
    if chown_result.returncode != 0:
        logger.warning(
            "chown 1000:1000 on workspace failed: %s",
            chown_result.stderr or chown_result.stdout,
        )

    return CONTAINER_WORKSPACE


def execute_task_in_docker(
    *,
    task,
    model_id: str,
    run_id: str,
    skill_dir: Path,
    timeout_multiplier: float = 1.0,
    image: str = DEFAULT_IMAGE,
    verbose: bool = False,
    asset_dirs: Optional[List[Path]] = None,
    thinking_level: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a single task inside a dedicated Docker container.

    Creates a container, sets up the agent, copies workspace files,
    runs the prompt, collects transcript and workspace artifacts, then tears down.

    Args:
        asset_dirs: Optional list of directories to search for asset files.
                    If None, defaults to skill_dir/assets and skill_dir/generated_assets.
    """
    from lib_agent import normalize_model_id, slugify_model

    model_slug = slugify_model(model_id)
    container_name = f"{model_slug}-{run_id}-{task.task_id}"
    agent_id = f"bench-{model_slug}"
    session_id = f"{task.task_id}_{int(time.time() * 1000)}"
    timeout_seconds = task.timeout_seconds * timeout_multiplier

    logger.info("🐳 [%s] Starting Docker container for task: %s", container_name, task.task_id)

    container = DockerContainer(container_name=container_name, image=image)
    start_time = time.time()
    stdout = ""
    stderr = ""
    exit_code = -1
    timed_out = False
    transcript: List[Dict[str, Any]] = []
    workspace_snapshot_dir: Optional[Path] = None

    try:
        container.start()

        # Prepare workspace files inside container
        prepare_docker_workspace(skill_dir, task, container, asset_dirs=asset_dirs)

        # Create the openclaw agent inside the container (delete first in case
        # copied openclaw.json already lists this agent id)
        normalized_model = normalize_model_id(model_id)
        container.exec(["openclaw", "agents", "delete", agent_id, "--force"])
        add_result = container.exec([
            "openclaw", "agents", "add", agent_id,
            "--model", normalized_model,
            "--workspace", CONTAINER_WORKSPACE,
            "--non-interactive",
        ])
        if add_result.returncode != 0:
            msg = (
                f"openclaw agents add failed (exit {add_result.returncode}). "
                f"stdout: {add_result.stdout!r} stderr: {add_result.stderr!r}"
            )
            logger.error("🐳 [%s] %s", container_name, msg)
            raise RuntimeError(msg)

        # Clean up any prior sessions for this agent inside the container.
        # Use lowercase since openclaw normalizes agent IDs to lowercase internally.
        agent_id_lower = agent_id.lower()
        container.exec([
            "sh", "-c",
            f"rm -rf {CONTAINER_OPENCLAW_HOME}/agents/{agent_id_lower}/sessions/*.jsonl "
            f"{CONTAINER_OPENCLAW_HOME}/agents/{agent_id_lower}/sessions/*.jsonl.lock "
            f"{CONTAINER_OPENCLAW_HOME}/agents/{agent_id_lower}/sessions/sessions.json",
        ])

        if verbose:
            logger.info("   [VERBOSE] Container: %s", container_name)
            logger.info("   [VERBOSE] Agent: %s, Model: %s", agent_id, normalized_model)
            logger.info("   [VERBOSE] Timeout: %.0fs", timeout_seconds)

        # Execute the task
        agent_cmd = [
            "openclaw", "agent",
            "--agent", agent_id,
            "--session-id", session_id,
            "--message", task.prompt,
        ]
        if thinking_level:
            agent_cmd.extend(["--thinking", thinking_level])
        result = container.exec(
            agent_cmd,
            timeout=timeout_seconds,
            workdir=CONTAINER_WORKSPACE,
        )
        stdout = result.stdout
        stderr = result.stderr
        exit_code = result.returncode
        if "timed out" in stderr:
            timed_out = True

        # Collect transcript from container
        transcript = _collect_transcript_from_container(container, agent_id, session_id, start_time)

        # Snapshot workspace from container to local temp dir for grading
        workspace_snapshot_dir = Path(f"/tmp/qwenclawbench/{run_id}/{task.task_id}")
        if workspace_snapshot_dir.exists():
            shutil.rmtree(workspace_snapshot_dir)
        workspace_snapshot_dir.mkdir(parents=True, exist_ok=True)
        container.copy_from(CONTAINER_WORKSPACE + "/.", workspace_snapshot_dir)

        if verbose:
            logger.info("   [VERBOSE] Exit code: %s", exit_code)
            logger.info("   [VERBOSE] Execution time: %.2fs", time.time() - start_time)
            if stdout:
                logger.info("   [VERBOSE] Stdout (first 1000 chars):\n%s", stdout[:1000])
            if stderr:
                logger.info("   [VERBOSE] Stderr:\n%s", stderr[:1000])
            logger.info("   [VERBOSE] Transcript entries: %d", len(transcript))

    except Exception as exc:
        logger.error("🐳 [%s] Container execution failed: %s", container_name, exc)
        stderr += f"\nDocker execution error: {exc}"
    finally:
        container.stop()

    execution_time = time.time() - start_time
    usage = _extract_usage(transcript)

    status = "success"
    if timed_out:
        status = "timeout"
    if not transcript:
        status = "error"
    if exit_code not in (0, -1) and not timed_out:
        status = "error"

    return {
        "agent_id": agent_id,
        "task_id": task.task_id,
        "status": status,
        "transcript": transcript,
        "usage": usage,
        "workspace": str(workspace_snapshot_dir) if workspace_snapshot_dir else "",
        "exit_code": exit_code,
        "timed_out": timed_out,
        "execution_time": execution_time,
        "stdout": stdout,
        "stderr": stderr,
    }


def _collect_transcript_from_container(
    container: DockerContainer,
    agent_id: str,
    session_id: str,
    started_at: float,
) -> List[Dict[str, Any]]:
    """Collect transcript JSONL from inside the container."""
    # openclaw normalizes agent IDs to lowercase internally
    agent_sessions = f"{CONTAINER_OPENCLAW_HOME}/agents/{agent_id.lower()}/sessions"

    # Try sessions.json first to find the real session ID
    result = container.exec(["cat", f"{agent_sessions}/sessions.json"])
    resolved_path = None

    if result.returncode == 0 and result.stdout.strip():
        try:
            sessions_payload = json.loads(result.stdout)
            if isinstance(sessions_payload, dict):
                # Find the most recent session
                newest_sid = None
                newest_ts = -1
                for entry in sessions_payload.values():
                    if not isinstance(entry, dict) or "sessionId" not in entry:
                        continue
                    updated_at = entry.get("updatedAt", 0)
                    if isinstance(updated_at, (int, float)) and updated_at > newest_ts:
                        newest_ts = updated_at
                        newest_sid = entry["sessionId"]
                if newest_sid:
                    resolved_path = f"{agent_sessions}/{newest_sid}.jsonl"
        except json.JSONDecodeError:
            pass

    # Fallback: list .jsonl files and pick the newest
    if not resolved_path:
        ls_result = container.exec(["sh", "-c", f"ls -t {agent_sessions}/*.jsonl 2>/dev/null"])
        if ls_result.returncode == 0 and ls_result.stdout.strip():
            resolved_path = ls_result.stdout.strip().split("\n")[0]

    # Last resort: try our session ID
    if not resolved_path:
        resolved_path = f"{agent_sessions}/{session_id}.jsonl"

    # Read the transcript
    cat_result = container.exec(["cat", resolved_path])
    if cat_result.returncode != 0:
        logger.warning(
            "Could not read transcript from container %s at %s: %s",
            container.container_name,
            resolved_path,
            cat_result.stderr,
        )
        return []

    transcript: List[Dict[str, Any]] = []
    for line in cat_result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            transcript.append(json.loads(line))
        except json.JSONDecodeError as exc:
            logger.warning("Failed to parse transcript line: %s", exc)
            transcript.append({"parse_error": str(exc), "skipped": True})

    logger.info(
        "🐳 Collected %d transcript entries from container %s",
        len(transcript),
        container.container_name,
    )
    return transcript


def _extract_usage(transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Sum token usage and cost from transcript (same logic as lib_agent)."""
    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "request_count": 0,
    }
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        if msg.get("role") != "assistant":
            continue
        totals["request_count"] += 1
        usage = msg.get("usage", {})
        totals["input_tokens"] += usage.get("input", 0)
        totals["output_tokens"] += usage.get("output", 0)
        totals["cache_read_tokens"] += usage.get("cacheRead", 0)
        totals["cache_write_tokens"] += usage.get("cacheWrite", 0)
        totals["total_tokens"] += usage.get("totalTokens", 0)
        cost = usage.get("cost", {})
        totals["cost_usd"] += cost.get("total", 0.0)
    return totals

def cleanup_containers(prefix: str = "qwenclawbench-") -> int:
    """Kill and remove all QwenClawBench Docker containers (matched by label).

    Containers are labeled at creation with ``qwenclawbench=1`` (see QWENCLAWBENCH_CONTAINER_LABEL).
    The ``prefix`` argument is deprecated and ignored; kept for backward compatibility.

    Also cleans up the per-container openclaw home copies under
    /tmp/qwenclawbench/docker_homes/.

    Returns the number of containers removed.
    """
    _ = prefix  # deprecated, unused
    # List matching containers (running or stopped)
    result = subprocess.run(
        [
            "docker", "ps", "-a",
            "--filter", f"label={QWENCLAWBENCH_CONTAINER_LABEL}",
            "--format", "{{.Names}}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        logger.warning("Failed to list containers: %s", result.stderr)
        return 0

    names = [n.strip() for n in result.stdout.splitlines() if n.strip()]
    if not names:
        logger.info("No qwenclawbench containers to clean up")
        return 0

    for name in names:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)

    logger.info("Removed %d container(s): %s", len(names), ", ".join(names))

    # Clean up host-side openclaw home copies
    docker_homes = Path("/tmp/qwenclawbench/docker_homes")
    if docker_homes.exists():
        shutil.rmtree(docker_homes, ignore_errors=True)
        logger.info("Cleaned up %s", docker_homes)

    return len(names)
