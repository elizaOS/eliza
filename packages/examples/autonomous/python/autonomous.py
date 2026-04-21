from __future__ import annotations

import asyncio
import os
import pathlib
import time
import uuid
from dataclasses import dataclass
from typing import Literal

from elizaos_plugin_inmemorydb import MemoryStorage
from elizaos_plugin_local_ai import TextGenerationParams, create_plugin, parse_simple_xml
from elizaos_plugin_shell import ShellConfig, ShellService

DecisionAction = Literal["RUN", "SLEEP", "STOP"]


@dataclass(frozen=True)
class DecisionRun:
    action: Literal["RUN"]
    command: str
    note: str


@dataclass(frozen=True)
class DecisionSleep:
    action: Literal["SLEEP"]
    sleep_ms: int
    note: str


@dataclass(frozen=True)
class DecisionStop:
    action: Literal["STOP"]
    note: str


Decision = DecisionRun | DecisionSleep | DecisionStop


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    s = raw.strip()
    return s if s else default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _clamp(n: int, min_v: int, max_v: int) -> int:
    return max(min_v, min(max_v, n))


def _truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return f"{text[:max_len]}\n...<truncated {len(text) - max_len} chars>..."


def _base_command(command: str) -> str:
    parts = command.strip().split()
    return parts[0] if parts else ""


def _is_command_allowed(command: str, allowed_base_commands: list[str]) -> bool:
    trimmed = command.strip()
    if not trimmed:
        return False

    # Avoid meta characters; the TS/Python shell services switch to `sh -c` when seeing these.
    meta = ["|", ">", "<", ";", "&&", "||"]
    if any(m in trimmed for m in meta):
        return False

    return _base_command(trimmed) in allowed_base_commands


def _build_prompt(
    *,
    goal: str,
    allowed_directory: str,
    allowed_commands: list[str],
    recent_steps: str,
) -> str:
    allowed_cmd_list = ", ".join(allowed_commands)
    return f"""
You are an autonomous agent running inside a sandbox directory on the local machine.

GOAL:
{goal}

SANDBOX:
- You may ONLY run shell commands inside: {allowed_directory}
- You may ONLY use these base commands: {allowed_cmd_list}
- Never use networking, package managers, or process control.
- If you cannot make progress safely, choose SLEEP.

RECENT HISTORY (most recent last):
{recent_steps}

Choose exactly ONE next step and output ONLY this XML (no extra text):
<response>
  <action>RUN|SLEEP|STOP</action>
  <command>...</command>
  <sleepMs>...</sleepMs>
  <note>short reason</note>
</response>

Rules:
- If action is RUN, include <command> and omit <sleepMs>.
- If action is SLEEP, include <sleepMs> (100-60000) and omit <command>.
- If action is STOP, omit both <command> and <sleepMs>.
- Keep output short.
""".strip()


def _parse_decision(raw_text: str) -> Decision | None:
    parsed = parse_simple_xml(raw_text)
    if not parsed:
        return None

    action_raw = parsed.get("action")
    if not isinstance(action_raw, str):
        return None
    action = action_raw.strip().upper()

    note_val = parsed.get("note")
    note = note_val if isinstance(note_val, str) else ""

    if action == "STOP":
        return DecisionStop(action="STOP", note=note)

    if action == "SLEEP":
        sleep_val = parsed.get("sleepMs")
        try:
            sleep_ms = int(str(sleep_val))
        except (TypeError, ValueError):
            return None
        return DecisionSleep(action="SLEEP", sleep_ms=_clamp(sleep_ms, 100, 60000), note=note)

    if action == "RUN":
        cmd_val = parsed.get("command")
        if not isinstance(cmd_val, str) or not cmd_val.strip():
            return None
        return DecisionRun(action="RUN", command=cmd_val.strip(), note=note)

    return None


async def main() -> None:
    here = pathlib.Path(__file__).resolve().parent
    repo_root = here.parent.parent.parent

    default_sandbox_dir = repo_root / "examples" / "autonomous" / "sandbox"
    allowed_directory = pathlib.Path(
        _env_str("SHELL_ALLOWED_DIRECTORY", str(default_sandbox_dir))
    ).resolve()
    allowed_directory.mkdir(parents=True, exist_ok=True)

    # Ensure plugin-shell reads the same constrained directory
    os.environ["SHELL_ALLOWED_DIRECTORY"] = str(allowed_directory)

    goal_file = pathlib.Path(
        _env_str("AUTONOMY_GOAL_FILE", str(allowed_directory / "GOAL.txt"))
    )
    stop_file = pathlib.Path(
        _env_str("AUTONOMY_STOP_FILE", str(allowed_directory / "STOP"))
    )

    interval_ms = _clamp(_env_int("AUTONOMY_INTERVAL_MS", 2000), 100, 60000)
    max_steps = _clamp(_env_int("AUTONOMY_MAX_STEPS", 200), 1, 1_000_000)

    allowed_commands = [
        s.strip()
        for s in _env_str("AUTONOMY_ALLOWED_COMMANDS", "ls,pwd,cat,echo,touch,mkdir").split(",")
        if s.strip()
    ]

    if not goal_file.exists():
        goal_file.write_text(
            "\n".join(
                [
                    "Explore the sandbox directory safely.",
                    "Create a short STATUS.txt describing what you found.",
                    "Keep commands small and only use allowed commands.",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

    # Local inference (GGUF) via plugin-local-ai (llama-cpp-python).
    local_ai = create_plugin()

    # In-memory DB via plugin-inmemorydb.
    storage = MemoryStorage()
    await storage.init()
    steps_collection = "autonomous_steps"

    # Shell via plugin-shell.
    shell_config = ShellConfig.from_env()
    shell_service = ShellService(shell_config)

    print(
        "\n".join(
            [
                "Starting sandboxed autonomous loop (Python).",
                f"- sandbox: {allowed_directory}",
                f"- goal file: {goal_file}",
                f"- stop file: {stop_file}",
                f"- intervalMs: {interval_ms}",
                f"- maxSteps: {max_steps}",
                f"- allowedCommands: {', '.join(allowed_commands)}",
                "",
            ]
        )
    )

    recent_summaries: list[str] = []

    for step in range(1, max_steps + 1):
        if stop_file.exists():
            print(f"STOP file found at {stop_file}; exiting.")
            break

        goal = goal_file.read_text(encoding="utf-8").strip()

        recent_steps_text = "\n\n---\n\n".join(recent_summaries[-10:]) if recent_summaries else "(none yet)"
        prompt = _build_prompt(
            goal=goal,
            allowed_directory=str(allowed_directory),
            allowed_commands=allowed_commands,
            recent_steps=recent_steps_text,
        )

        try:
            result = local_ai.generate_text(
                TextGenerationParams(
                    prompt=prompt,
                    max_tokens=512,
                    temperature=0.7,
                    top_p=0.9,
                    stop_sequences=[],
                    use_large_model=False,
                )
            )
            raw_text = result.text
        except Exception as e:
            raw_text = f"<response><action>SLEEP</action><sleepMs>2000</sleepMs><note>model-error:{e}</note></response>"

        decision = _parse_decision(raw_text) or DecisionSleep(
            action="SLEEP", sleep_ms=2000, note="parse-failed"
        )

        decided_at = int(time.time() * 1000)

        shell_summary = ""
        if isinstance(decision, DecisionRun):
            if not _is_command_allowed(decision.command, allowed_commands):
                shell_summary = f"shell: not executed (command-not-allowed): {decision.command}"
            elif not shell_config.enabled:
                shell_summary = "shell: not executed (shell disabled)"
            else:
                cmd_result = await shell_service.execute_command(
                    decision.command, conversation_id="autonomous"
                )
                shell_summary_lines: list[str] = [
                    f"result: success={cmd_result.success} exitCode={cmd_result.exit_code} cwd={cmd_result.executed_in}"
                ]
                if cmd_result.stdout:
                    shell_summary_lines.append(f"stdout:\n{_truncate(cmd_result.stdout, 2000)}")
                if cmd_result.stderr:
                    shell_summary_lines.append(f"stderr:\n{_truncate(cmd_result.stderr, 2000)}")
                if cmd_result.error:
                    shell_summary_lines.append(f"error: {cmd_result.error}")
                shell_summary = "\n".join(shell_summary_lines)

        summary_lines: list[str] = [f"[step {step}] {decision.action}"]
        if decision.note:
            summary_lines.append(f"note: {decision.note}")
        if isinstance(decision, DecisionRun):
            summary_lines.append(f"command: {decision.command}")
        if isinstance(decision, DecisionSleep):
            summary_lines.append(f"sleepMs: {decision.sleep_ms}")
        if shell_summary:
            summary_lines.append(shell_summary)

        summary = "\n".join(summary_lines)
        print(f"\n{summary}\n")

        # Persist into plugin-inmemorydb storage (ephemeral)
        await storage.set(
            steps_collection,
            str(uuid.uuid4()),
            {
                "step": step,
                "decidedAt": decided_at,
                "summary": summary,
                "goal": goal,
            },
        )
        recent_summaries.append(_truncate(summary, 1200))

        if isinstance(decision, DecisionStop):
            break

        sleep_for = decision.sleep_ms if isinstance(decision, DecisionSleep) else interval_ms
        await asyncio.sleep(sleep_for / 1000.0)

    await storage.close()


if __name__ == "__main__":
    asyncio.run(main())

