"""
OpenClaw agent execution helpers for QwenClawBench.
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from lib_tasks import Task


logger = logging.getLogger(__name__)
MAX_OPENCLAW_MESSAGE_CHARS = 4000

# Thinking levels supported by OpenClaw
# See: https://docs.openclaw.ai/tools/thinking
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "adaptive")

# Models that support xhigh thinking level (high reasoning budget)
# Sourced from OpenClaw src/auto-reply/thinking.ts XHIGH_MODEL_REFS
_XHIGH_MODELS = {
    "openai/gpt-5.4", "openai/gpt-5.4-pro", "openai/gpt-5.2",
    "openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex",
    "openai-codex/gpt-5.3-codex-spark", "openai-codex/gpt-5.2-codex",
    "openai-codex/gpt-5.1-codex",
    "github-copilot/gpt-5.2-codex", "github-copilot/gpt-5.2",
}
_XHIGH_MODELS_LOWER = {m.lower() for m in _XHIGH_MODELS}
_XHIGH_MODEL_IDS_LOWER = {m.split("/")[-1].lower() for m in _XHIGH_MODELS}

# adaptive thinking: currently provider-managed for Anthropic Claude 4.6
_ADAPTIVE_PROVIDER = "anthropic"
_ADAPTIVE_MODEL_PREFIXES = (
    "claude-opus-4-6", "claude-opus-4.6",
    "claude-sonnet-4-6", "claude-sonnet-4.6",
)


def supports_xhigh_thinking(model_id: str) -> bool:
    """Check if a model supports xhigh thinking level."""
    normalized = normalize_model_id(model_id).lower()
    if normalized in _XHIGH_MODELS_LOWER:
        return True
    parts = normalized.split("/")
    if len(parts) == 3 and parts[0] == "openrouter":
        if f"{parts[1]}/{parts[2]}" in _XHIGH_MODELS_LOWER:
            return True
    if "/" not in model_id:
        return model_id.lower() in _XHIGH_MODEL_IDS_LOWER

    # Handle custom provider prefix.
    # The model portion may use dot-notation ("openai.gpt-5.4-2026-03-05") and/or
    # carry a date suffix ("-2026-03-05").  Normalise by:
    #   1. Drop the leading provider segment (everything before the first "/")
    #   2a. If model_part has no sub-provider prefix (e.g. "gpt-5.4-2026-03-05"),
    #       strip the date suffix and check directly against model IDs.
    #   2b. Otherwise replace the first dot with "/" to recover "provider/model" form
    #   3. Strip any date suffix of the form "-YYYY-MM-DD"
    import re
    model_part = normalized.split("/", 1)[-1]          # "openai.gpt-5.4-2026-03-05" or "gpt-5.4-2026-03-05"
    # 2a: try bare model ID first (handles "gpt-5.4-2026-03-05" → "gpt-5.4")
    bare_model = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model_part)
    if bare_model in _XHIGH_MODEL_IDS_LOWER:
        return True
    # 2b: model_part has sub-provider prefix ("openai.gpt-5.4-2026-03-05")
    canonical = model_part.replace(".", "/", 1)         # "openai/gpt-5.4-2026-03-05"
    canonical = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", canonical)  # "openai/gpt-5.4"
    if canonical in _XHIGH_MODELS_LOWER:
        return True
    # Also check just the model ID portion after the (now restored) provider slash
    model_id_part = canonical.split("/")[-1]            # "gpt-5.4"
    return model_id_part in _XHIGH_MODEL_IDS_LOWER


def supports_adaptive_thinking(model_id: str) -> bool:
    """Check if a model natively supports adaptive thinking."""
    normalized = normalize_model_id(model_id).lower()
    parts = normalized.split("/")
    if len(parts) == 3 and parts[0] == "openrouter":
        provider, model = parts[1], parts[2]
    elif len(parts) >= 2:
        provider, model = parts[-2], parts[-1]
    else:
        return False
    if provider != _ADAPTIVE_PROVIDER:
        return False
    return any(model.startswith(prefix) for prefix in _ADAPTIVE_MODEL_PREFIXES)


def validate_thinking_level(level: str, model_id: Optional[str] = None) -> Optional[str]:
    """Validate a thinking level and check model compatibility.

    Returns the validated level (lowercased), or None if invalid/incompatible.
    """
    level_lower = level.lower().strip()
    if level_lower not in THINKING_LEVELS:
        logger.warning(
            "Invalid thinking level '%s'. Valid levels: %s",
            level, ", ".join(THINKING_LEVELS),
        )
        return None
    if level_lower == "xhigh" and model_id and not supports_xhigh_thinking(model_id):
        logger.warning(
            "Thinking level 'xhigh' not supported by model '%s'. "
            "xhigh is only available for GPT-5.x model families.", model_id,
        )
        return None
    if level_lower == "adaptive" and model_id and not supports_adaptive_thinking(model_id):
        logger.warning(
            "Thinking level 'adaptive' is not natively supported by model '%s'. "
            "adaptive is currently intended for Anthropic Claude 4.6 models.", model_id,
        )
        return None
    return level_lower


def slugify_model(model_id: str) -> str:
    return model_id.replace("/", "-").replace(".", "-")


def normalize_model_id(model_id: str) -> str:
    """Return model id as-is for OpenClaw.

    OpenClaw expects either a bare model name (no provider prefix) or a
    provider-qualified id like "custom-provider/claude-opus-4-6-20260205".  When the
    model id already contains a "/" it is already provider-qualified and must be
    passed through unchanged — adding an "openrouter/" prefix breaks custom
    providers (dashscope-*, etc.) defined in openclaw.json.
    """
    return model_id


def _get_agent_workspace(agent_id: str) -> Path | None:
    """Get the workspace path for an agent from OpenClaw config."""
    try:
        list_result = subprocess.run(
            ["openclaw", "agents", "list"],
            capture_output=True,
            text=True,
            check=False,
        )
        if list_result.returncode != 0:
            return None

        # Parse the agent list output to find workspace
        # OpenClaw normalizes colons to dashes in agent names, so check both.
        normalized_id = agent_id.replace(":", "-")
        lines = list_result.stdout.split("\n")
        found_agent = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith(f"- {agent_id}") or stripped.startswith(f"- {normalized_id}"):
                found_agent = True
            elif found_agent and "Workspace:" in line:
                workspace_str = line.split("Workspace:")[1].strip()
                # Expand ~ if present
                if workspace_str.startswith("~/"):
                    workspace_str = str(Path.home() / workspace_str[2:])
                return Path(workspace_str)
            elif found_agent and line.strip().startswith("-"):
                # Found next agent, stop looking
                break
        return None
    except Exception as exc:
        logger.warning("Failed to get agent workspace: %s", exc)
        return None


def ensure_agent_exists(agent_id: str, model_id: str, workspace_dir: Path) -> bool:
    """Ensure the OpenClaw agent exists with the correct workspace.

    If the agent already exists but points to a different workspace, it is
    deleted and recreated so that the new workspace takes effect.
    Returns True if the agent was (re)created.
    """
    workspace_dir.mkdir(parents=True, exist_ok=True)

    try:
        list_result = subprocess.run(
            ["openclaw", "agents", "list"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        logger.error("openclaw CLI not found while listing agents")
        return False

    if list_result.returncode == 0:
        # Check for exact agent ID match — avoid substring false positives
        # (e.g. "bench-foo-4" matching "bench-foo-4-5" in the output).
        # Output format is "- <agent_id>" or "- <agent_id> (default)" per line.
        # OpenClaw normalizes colons to dashes in directory/display names, so
        # also check the normalized form.
        existing_agents = set()
        for line in list_result.stdout.splitlines():
            line = line.strip()
            if line.startswith("- "):
                # Extract agent name: "- bench-foo-4-5" or "- main (default)"
                name_part = line[2:].split()[0] if line[2:].strip() else ""
                if name_part:
                    existing_agents.add(name_part)
        normalized_id = agent_id.replace(":", "-")
        if agent_id in existing_agents or normalized_id in existing_agents:
            # Agent exists — check if workspace matches
            current_workspace = _get_agent_workspace(agent_id)
            if (
                current_workspace is not None
                and current_workspace.resolve() == workspace_dir.resolve()
            ):
                logger.info("Agent %s already exists with correct workspace", agent_id)
                return False
            # Workspace is stale or unknown — delete and recreate
            delete_name = normalized_id if normalized_id in existing_agents else agent_id
            logger.info(
                "Agent %s exists with stale workspace (%s != %s), recreating",
                agent_id,
                current_workspace,
                workspace_dir,
            )
            subprocess.run(
                ["openclaw", "agents", "delete", delete_name, "--force"],
                capture_output=True,
                text=True,
                check=False,
            )

    normalized_model = normalize_model_id(model_id)
    logger.info("Creating OpenClaw agent %s", agent_id)
    try:
        create_result = subprocess.run(
            [
                "openclaw",
                "agents",
                "add",
                agent_id,
                "--model",
                normalized_model,
                "--workspace",
                str(workspace_dir),
                "--non-interactive",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        logger.error("openclaw CLI not found while creating agent")
        return False

    if create_result.returncode != 0:
        logger.warning(
            "Agent creation returned %s: %s", create_result.returncode, create_result.stderr
        )
    return True


def cleanup_agent_sessions(agent_id: str) -> None:
    """Remove stored session transcripts for an agent to avoid unbounded growth."""
    agent_dir = _get_agent_store_dir(agent_id)
    sessions_dir = agent_dir / "sessions"
    if not sessions_dir.exists():
        return
    removed = 0
    for pattern in ("*.jsonl", "*.jsonl.lock"):
        for path in sessions_dir.glob(pattern):
            try:
                path.unlink()
                removed += 1
            except OSError as exc:
                logger.warning("Failed to remove session file %s: %s", path, exc)
    sessions_store = sessions_dir / "sessions.json"
    if sessions_store.exists():
        try:
            sessions_store.unlink()
        except OSError as exc:
            logger.warning("Failed to remove session store %s: %s", sessions_store, exc)
    if removed:
        logger.info("Removed %s old OpenClaw session transcripts for %s", removed, agent_id)


def prepare_task_workspace(skill_dir: Path, run_id: str, task: Task, agent_id: str) -> Path:
    """
    Prepare workspace for a task by copying fixtures.
    Uses the agent's configured workspace to ensure files are in the right place.

    Asset lookup order for source/dest files:
      1. {skill_dir}/assets/{source}
      2. {skill_dir}/generated_assets/{source}
    This allows generated tasks to reference assets in generated_assets/ without
    needing to copy them into the main assets/ directory.
    """
    import shutil

    # Get agent's workspace from agent config
    workspace = _get_agent_workspace(agent_id)
    if workspace is None:
        # Fallback to task-specific workspace if agent workspace not found
        logger.warning("Could not find agent workspace, using fallback")
        workspace = Path(f"/tmp/pinchbench/{run_id}/{task.task_id}")

    # Clear workspace before each task to prevent stale files from prior tasks
    # from contaminating the agent's context.
    if workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True, exist_ok=True)

    # Asset search directories (in priority order)
    asset_search_dirs = [
        skill_dir / "assets",
        skill_dir / "generated_assets",
    ]

    for file_spec in task.workspace_files:
        if "content" in file_spec:
            dest = workspace / file_spec["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(file_spec["content"])
            continue

        # Search for source file across asset directories
        source_rel = file_spec["source"]
        dest = workspace / file_spec["dest"]
        dest.parent.mkdir(parents=True, exist_ok=True)

        source_found = None
        for asset_dir in asset_search_dirs:
            candidate = asset_dir / source_rel
            if candidate.exists():
                source_found = candidate
                break

        if source_found is None:
            searched = [str(d / source_rel) for d in asset_search_dirs]
            logger.error(
                "Workspace file not found: %s (searched: %s)",
                source_rel,
                ", ".join(searched),
            )
            raise FileNotFoundError(
                f"Asset file '{source_rel}' not found in any of: {searched}"
            )

        try:
            dest.write_bytes(source_found.read_bytes())
        except FileNotFoundError:
            logger.error("Workspace file not found: %s", source_found)
            raise

    return workspace


def _get_agent_store_dir(agent_id: str) -> Path:
    base_dir = Path.home() / ".openclaw" / "agents"
    direct_dir = base_dir / agent_id
    if direct_dir.exists():
        return direct_dir
    normalized_dir = base_dir / agent_id.replace(":", "-")
    if normalized_dir.exists():
        return normalized_dir
    return direct_dir


def _resolve_session_id_from_store(agent_id: str) -> str | None:
    agent_dir = _get_agent_store_dir(agent_id)
    sessions_store = agent_dir / "sessions" / "sessions.json"
    if not sessions_store.exists():
        return None
    try:
        sessions_payload = json.loads(sessions_store.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.warning("Failed to parse sessions store: %s", exc)
        return None
    if not isinstance(sessions_payload, dict):
        return None

    normalized_id = agent_id.replace(":", "-")
    preferred_keys = [
        f"agent:{agent_id}:main",
        f"agent:{agent_id}:default",
        f"agent:{normalized_id}:main",
        f"agent:{normalized_id}:default",
    ]
    for key in preferred_keys:
        entry = sessions_payload.get(key)
        if isinstance(entry, dict) and entry.get("sessionId"):
            return entry["sessionId"]

    newest_entry = None
    newest_timestamp = -1
    for entry in sessions_payload.values():
        if not isinstance(entry, dict):
            continue
        if "sessionId" not in entry:
            continue
        updated_at = entry.get("updatedAt")
        if isinstance(updated_at, (int, float)) and updated_at > newest_timestamp:
            newest_timestamp = updated_at
            newest_entry = entry
    if newest_entry:
        return newest_entry.get("sessionId")
    return None


def _find_recent_session_path(agent_dir: Path, started_at: float) -> Path | None:
    sessions_dir = agent_dir / "sessions"
    if not sessions_dir.exists():
        return None
    candidates = list(sessions_dir.glob("*.jsonl"))
    if not candidates:
        return None
    tolerance_seconds = 5.0
    recent_candidates = [
        path for path in candidates if path.stat().st_mtime >= (started_at - tolerance_seconds)
    ]
    pool = recent_candidates or candidates
    return max(pool, key=lambda path: path.stat().st_mtime)


def _load_transcript(agent_id: str, session_id: str, started_at: float) -> List[Dict[str, Any]]:
    agent_dir = _get_agent_store_dir(agent_id)
    transcript_path = None

    # OpenClaw ignores the --session-id we pass and generates its own UUID-based
    # session ID internally.  We need to discover the actual transcript path.
    #
    # Strategy (with retries to handle write-delay):
    #   1. Resolve the real session ID from sessions.json
    #   2. Glob for any .jsonl in the sessions dir (most-recently-modified)
    #   3. Try our passed-in session ID as a last resort
    for attempt in range(6):
        # 1. Try sessions.json first — OpenClaw writes the real UUID here
        resolved_session_id = _resolve_session_id_from_store(agent_id)
        if resolved_session_id:
            candidate = agent_dir / "sessions" / f"{resolved_session_id}.jsonl"
            if candidate.exists():
                transcript_path = candidate
                logger.info(
                    "Found transcript via sessions.json: %s (attempt %s)",
                    candidate.name,
                    attempt + 1,
                )
                break

        # 2. Glob fallback — pick the most recently modified .jsonl
        recent_path = _find_recent_session_path(agent_dir, started_at)
        if recent_path is not None:
            transcript_path = recent_path
            logger.info(
                "Found transcript via glob fallback: %s (attempt %s)",
                recent_path.name,
                attempt + 1,
            )
            break

        # 3. Try our passed-in session ID (unlikely to work, but check anyway)
        direct_path = agent_dir / "sessions" / f"{session_id}.jsonl"
        if direct_path.exists():
            transcript_path = direct_path
            logger.info(
                "Found transcript via passed session ID: %s (attempt %s)",
                direct_path.name,
                attempt + 1,
            )
            break

        if attempt < 5:
            time.sleep(1.0)

    if transcript_path is None:
        sessions_dir = agent_dir / "sessions"
        if sessions_dir.exists():
            all_files = list(sessions_dir.iterdir())
            logger.warning(
                "Transcript not found for agent %s. Sessions dir contents: %s",
                agent_id,
                [f.name for f in all_files],
            )
        else:
            logger.warning(
                "Transcript not found — sessions dir does not exist: %s",
                sessions_dir,
            )
        return []

    transcript: List[Dict[str, Any]] = []
    for line in transcript_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            transcript.append(json.loads(line))
        except json.JSONDecodeError as exc:
            logger.warning("Failed to parse transcript line: %s", exc)
            transcript.append({"parse_error": str(exc), "skipped": True})
    return transcript


def _extract_usage_from_transcript(transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Sum token usage and cost from all assistant messages in transcript."""
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


def execute_openclaw_task(
    *,
    task: Task,
    agent_id: str,
    model_id: str,
    run_id: str,
    timeout_multiplier: float,
    skill_dir: Path,
    verbose: bool = False,
) -> Dict[str, Any]:
    logger.info("🤖 Agent [%s] starting task: %s", agent_id, task.task_id)
    logger.info("   Task: %s", task.name)
    logger.info("   Category: %s", task.category)
    if verbose:
        logger.info(
            "   Prompt: %s", task.prompt[:500] + "..." if len(task.prompt) > 500 else task.prompt
        )

    # Clean up previous session transcripts so we can reliably find this task's
    # transcript (OpenClaw uses its own UUID-based naming, not our session ID).
    cleanup_agent_sessions(agent_id)

    start_time = time.time()
    workspace = prepare_task_workspace(skill_dir, run_id, task, agent_id)
    session_id = f"{task.task_id}_{int(time.time() * 1000)}"
    timeout_seconds = task.timeout_seconds * timeout_multiplier
    stdout = ""
    stderr = ""
    exit_code = -1
    timed_out = False

    try:
        result = subprocess.run(
            [
                "openclaw",
                "agent",
                "--agent",
                agent_id,
                "--session-id",
                session_id,
                "--message",
                task.prompt,
            ],
            capture_output=True,
            text=True,
            cwd=str(workspace),
            timeout=timeout_seconds,
            check=False,
        )
        stdout = result.stdout
        stderr = result.stderr
        exit_code = result.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
    except FileNotFoundError as exc:
        stderr = f"openclaw command not found: {exc}"

    transcript = _load_transcript(agent_id, session_id, start_time)
    usage = _extract_usage_from_transcript(transcript)
    execution_time = time.time() - start_time

    status = "success"
    if timed_out:
        status = "timeout"
    if not transcript:
        status = "error"
    if exit_code not in (0, -1) and not timed_out:
        status = "error"
    if stderr and "openclaw command not found" in str(stderr):
        status = "error"

    # Verbose logging for debugging
    if verbose:
        logger.info("   [VERBOSE] Exit code: %s", exit_code)
        logger.info("   [VERBOSE] Execution time: %.2fs", execution_time)
        logger.info("   [VERBOSE] Workspace: %s", workspace)
        if stdout:
            logger.info("   [VERBOSE] Stdout (first 1000 chars):\n%s", stdout[:1000])
        if stderr:
            logger.info("   [VERBOSE] Stderr:\n%s", stderr[:1000])
        logger.info("   [VERBOSE] Transcript entries: %d", len(transcript))

        # Show agent responses from transcript
        for entry in transcript:
            if entry.get("type") == "message":
                msg = entry.get("message", {})
                role = msg.get("role", "unknown")
                content = msg.get("content", "")
                if role == "assistant":
                    # Truncate long responses
                    preview = content[:500] + "..." if len(content) > 500 else content
                    logger.info("   [VERBOSE] Agent response: %s", preview)
                elif role == "user":
                    preview = content[:200] + "..." if len(content) > 200 else content
                    logger.info("   [VERBOSE] User message: %s", preview)

        # Show workspace files after task
        if workspace.exists():
            logger.info("   [VERBOSE] Workspace files after task:")
            for f in sorted(workspace.rglob("*")):
                if f.is_file():
                    try:
                        size = f.stat().st_size
                        logger.info("      %s (%d bytes)", f.relative_to(workspace), size)
                    except OSError:
                        logger.info("      %s", f.relative_to(workspace))

    return {
        "agent_id": agent_id,
        "task_id": task.task_id,
        "status": status,
        "transcript": transcript,
        "usage": usage,
        "workspace": str(workspace),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "execution_time": execution_time,
        "stdout": stdout,
        "stderr": stderr,
    }


def run_openclaw_prompt(
    *,
    agent_id: str,
    prompt: str,
    workspace: Path,
    timeout_seconds: float,
) -> Dict[str, Any]:
    """Run a single OpenClaw prompt for helper agents like the judge."""
    # Clean up previous session transcripts so we can reliably find this
    # prompt's transcript (OpenClaw uses its own UUID-based naming).
    cleanup_agent_sessions(agent_id)

    start_time = time.time()
    workspace.mkdir(parents=True, exist_ok=True)
    session_id = f"judge_{int(time.time() * 1000)}"
    stdout = ""
    stderr = ""
    exit_code = -1
    timed_out = False

    chunks = [
        prompt[i : i + MAX_OPENCLAW_MESSAGE_CHARS]
        for i in range(0, max(1, len(prompt)), MAX_OPENCLAW_MESSAGE_CHARS)
    ]
    if len(chunks) > 1:
        total_chunks = len(chunks)
        chunks = [
            (
                f"You are receiving a long prompt in {total_chunks} parts.\n"
                f"Ignore and do not respond until the final part.\n\n"
                f"Part 1/{total_chunks}:\n{chunks[0]}"
            )
        ] + [
            (
                f"Part {i + 2}/{total_chunks}:\n{chunks[i + 1]}"
                if i + 2 < total_chunks
                else (
                    f"Part {i + 2}/{total_chunks} (final):\n{chunks[i + 1]}\n"
                    "All parts received. Proceed with final judgment now."
                )
            )
            for i in range(0, total_chunks - 1)
        ]
    for chunk in chunks:
        elapsed = time.time() - start_time
        remaining = timeout_seconds - elapsed
        if remaining <= 0:
            timed_out = True
            break
        try:
            result = subprocess.run(
                [
                    "openclaw",
                    "agent",
                    "--agent",
                    agent_id,
                    "--session-id",
                    session_id,
                    "--message",
                    chunk,
                ],
                capture_output=True,
                text=True,
                cwd=str(workspace),
                timeout=remaining,
                check=False,
            )
            stdout += result.stdout
            stderr += result.stderr
            exit_code = result.returncode
            if result.returncode not in (0, -1) and not timed_out:
                break
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout += exc.stdout or ""
            stderr += exc.stderr or ""
            break
        except FileNotFoundError as exc:
            stderr += f"openclaw command not found: {exc}"
            break

    transcript = _load_transcript(agent_id, session_id, start_time)
    execution_time = time.time() - start_time

    status = "success"
    if timed_out:
        status = "timeout"
    if not transcript:
        status = "error"
    if exit_code not in (0, -1) and not timed_out:
        status = "error"
    if stderr and "openclaw command not found" in str(stderr):
        status = "error"

    return {
        "agent_id": agent_id,
        "status": status,
        "transcript": transcript,
        "workspace": str(workspace),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "execution_time": execution_time,
        "stdout": stdout,
        "stderr": stderr,
    }
