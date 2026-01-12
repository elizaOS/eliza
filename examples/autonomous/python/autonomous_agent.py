#!/usr/bin/env python3
"""
Autonomous Self-Looping Agent (Python)

A sandboxed, self-looping autonomous agent that:
- Thinks locally using llama-cpp-python with a small GGUF model
- Acts by running commands via a sandboxed shell service
- Remembers via in-memory storage

The agent runs a continuous loop: plan → act → observe → store → repeat
"""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Literal


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class AutonomousConfig:
    """Configuration for the autonomous agent."""

    sandbox_dir: Path
    models_dir: Path
    model_name: str
    loop_interval_ms: int
    max_iterations: int
    max_consecutive_failures: int
    stop_file: Path
    conversation_id: str
    agent_id: str
    memory_context_size: int
    context_size: int
    gpu_layers: int
    temperature: float
    max_tokens: int
    shell_timeout_ms: int

    @classmethod
    def from_env(cls) -> AutonomousConfig:
        """Load configuration from environment variables."""
        script_dir = Path(__file__).parent.resolve()
        default_sandbox = script_dir.parent / "sandbox"
        default_models = Path.home() / ".eliza" / "models"

        sandbox_dir = Path(os.environ.get("SANDBOX_DIR", str(default_sandbox)))
        models_dir = Path(os.environ.get("MODELS_DIR", str(default_models)))
        model_name = os.environ.get("LOCAL_SMALL_MODEL", "Qwen3-4B-Q4_K_M.gguf")

        return cls(
            sandbox_dir=sandbox_dir,
            models_dir=models_dir,
            model_name=model_name,
            loop_interval_ms=int(os.environ.get("LOOP_INTERVAL_MS", "3000")),
            max_iterations=int(os.environ.get("MAX_ITERATIONS", "1000")),
            max_consecutive_failures=int(os.environ.get("MAX_CONSECUTIVE_FAILURES", "5")),
            stop_file=sandbox_dir / "STOP",
            conversation_id=os.environ.get("CONVERSATION_ID", str(uuid.uuid4())),
            agent_id=os.environ.get("AGENT_ID", str(uuid.uuid4())),
            memory_context_size=int(os.environ.get("MEMORY_CONTEXT_SIZE", "10")),
            context_size=int(os.environ.get("CONTEXT_SIZE", "8192")),
            gpu_layers=int(os.environ.get("GPU_LAYERS", "0")),
            temperature=float(os.environ.get("TEMPERATURE", "0.7")),
            max_tokens=int(os.environ.get("MAX_TOKENS", "512")),
            shell_timeout_ms=int(os.environ.get("SHELL_TIMEOUT", "30000")),
        )


# ============================================================================
# Types
# ============================================================================

class ActionType(str, Enum):
    """Possible agent actions."""

    RUN = "RUN"
    SLEEP = "SLEEP"
    STOP = "STOP"


@dataclass
class AgentDecision:
    """A decision made by the agent."""

    action: ActionType
    command: str | None = None
    sleep_ms: int | None = None
    note: str | None = None


@dataclass
class ExecutionResult:
    """Result of executing a shell command."""

    success: bool
    exit_code: int | None
    stdout: str
    stderr: str
    cwd: str


@dataclass
class IterationRecord:
    """Record of a single iteration of the autonomous loop."""

    id: str
    timestamp: float
    step: int
    prompt_summary: str
    decision: AgentDecision
    result: ExecutionResult | None
    derived_summary: str


# ============================================================================
# Memory Storage
# ============================================================================

class AgentMemory:
    """In-memory storage for iteration records."""

    def __init__(self) -> None:
        self._records: list[IterationRecord] = []

    def store(self, record: IterationRecord) -> None:
        """Store an iteration record."""
        self._records.append(record)

    def get_recent_records(self, count: int) -> list[IterationRecord]:
        """Get the most recent records."""
        return self._records[-count:] if count > 0 else []

    def get_iteration_count(self) -> int:
        """Get total number of stored iterations."""
        return len(self._records)


# ============================================================================
# Shell Service
# ============================================================================

ADDITIONAL_FORBIDDEN_COMMANDS = frozenset([
    "curl", "wget", "ssh", "scp", "rsync", "nc", "netcat", "socat",
    "python", "python3", "node", "bun", "deno",
    "kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff",
    "chown", "chmod", "chgrp", "sudo", "su",
])

DANGEROUS_PATTERNS = [
    re.compile(r"\.\.\/"),           # Path traversal
    re.compile(r"\$\("),             # Command substitution
    re.compile(r"`"),                # Backtick command substitution
    re.compile(r";\s*rm\s"),         # Chained rm
    re.compile(r"&&\s*rm\s"),        # Chained rm
    re.compile(r"\|\|\s*rm\s"),      # Chained rm
]


def is_command_allowed(command: str) -> bool:
    """Check if a command is allowed to execute."""
    trimmed = command.strip().lower()
    parts = trimmed.split()
    if not parts:
        return False

    base_command = parts[0].split("/")[-1]

    if base_command in ADDITIONAL_FORBIDDEN_COMMANDS:
        return False

    for pattern in DANGEROUS_PATTERNS:
        if pattern.search(trimmed):
            return False

    return True


class ShellService:
    """Sandboxed shell command execution service."""

    def __init__(self, config: AutonomousConfig) -> None:
        self._config = config
        self._current_directory = config.sandbox_dir
        self._command_history: list[tuple[str, ExecutionResult]] = []

        # Ensure sandbox exists
        self._config.sandbox_dir.mkdir(parents=True, exist_ok=True)

    @property
    def current_directory(self) -> Path:
        """Get current working directory."""
        return self._current_directory

    def get_command_history(self, limit: int = 10) -> list[str]:
        """Get recent command history."""
        history = self._command_history[-limit:] if limit > 0 else self._command_history
        return [f"$ {cmd}" for cmd, _ in history]

    async def execute_command(self, command: str) -> ExecutionResult:
        """Execute a command in the sandbox."""
        trimmed = command.strip()

        # Handle cd command specially
        if trimmed.startswith("cd "):
            return await self._handle_cd(trimmed)

        # Validate command
        if not is_command_allowed(trimmed):
            result = ExecutionResult(
                success=False,
                exit_code=1,
                stdout="",
                stderr="Command blocked by security policy",
                cwd=str(self._current_directory),
            )
            return result

        # Check if command uses shell features
        use_shell = any(c in trimmed for c in [">", "<", "|"])

        try:
            timeout_seconds = self._config.shell_timeout_ms / 1000.0

            if use_shell:
                cmd_args = ["sh", "-c", trimmed]
            else:
                cmd_args = shlex.split(trimmed)

            process = await asyncio.wait_for(
                asyncio.create_subprocess_exec(
                    *cmd_args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=str(self._current_directory),
                    env=os.environ.copy(),
                ),
                timeout=timeout_seconds,
            )

            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout_seconds,
            )

            result = ExecutionResult(
                success=process.returncode == 0,
                exit_code=process.returncode,
                stdout=stdout_bytes.decode("utf-8", errors="replace")[:1000],
                stderr=stderr_bytes.decode("utf-8", errors="replace")[:500],
                cwd=str(self._current_directory),
            )

        except TimeoutError:
            result = ExecutionResult(
                success=False,
                exit_code=None,
                stdout="",
                stderr="Command timed out",
                cwd=str(self._current_directory),
            )

        except FileNotFoundError:
            result = ExecutionResult(
                success=False,
                exit_code=127,
                stdout="",
                stderr=f"Command not found: {cmd_args[0] if cmd_args else 'unknown'}",
                cwd=str(self._current_directory),
            )

        except Exception as e:
            result = ExecutionResult(
                success=False,
                exit_code=1,
                stdout="",
                stderr=str(e),
                cwd=str(self._current_directory),
            )

        self._command_history.append((trimmed, result))
        return result

    async def _handle_cd(self, command: str) -> ExecutionResult:
        """Handle cd command."""
        parts = command.split(maxsplit=1)

        if len(parts) < 2:
            self._current_directory = self._config.sandbox_dir
            return ExecutionResult(
                success=True,
                exit_code=0,
                stdout=f"Changed directory to: {self._current_directory}",
                stderr="",
                cwd=str(self._current_directory),
            )

        target = parts[1].strip()

        # Resolve path
        if target.startswith("/"):
            new_path = Path(target)
        else:
            new_path = (self._current_directory / target).resolve()

        # Security: ensure within sandbox
        try:
            new_path = new_path.resolve()
            sandbox_resolved = self._config.sandbox_dir.resolve()

            if not str(new_path).startswith(str(sandbox_resolved)):
                return ExecutionResult(
                    success=False,
                    exit_code=1,
                    stdout="",
                    stderr="Cannot navigate outside sandbox directory",
                    cwd=str(self._current_directory),
                )

            if not new_path.exists():
                return ExecutionResult(
                    success=False,
                    exit_code=1,
                    stdout="",
                    stderr=f"Directory does not exist: {new_path}",
                    cwd=str(self._current_directory),
                )

            if not new_path.is_dir():
                return ExecutionResult(
                    success=False,
                    exit_code=1,
                    stdout="",
                    stderr=f"Not a directory: {new_path}",
                    cwd=str(self._current_directory),
                )

            self._current_directory = new_path
            result = ExecutionResult(
                success=True,
                exit_code=0,
                stdout=f"Changed directory to: {self._current_directory}",
                stderr="",
                cwd=str(self._current_directory),
            )
            self._command_history.append((command, result))
            return result

        except Exception as e:
            return ExecutionResult(
                success=False,
                exit_code=1,
                stdout="",
                stderr=str(e),
                cwd=str(self._current_directory),
            )


# ============================================================================
# Local AI Service
# ============================================================================

class LocalAIService:
    """Local AI inference using llama-cpp-python."""

    def __init__(self, config: AutonomousConfig) -> None:
        self._config = config
        self._model: object | None = None

    def _get_model(self) -> object:
        """Lazy-load the LLM model."""
        if self._model is None:
            try:
                from llama_cpp import Llama
            except ImportError as e:
                raise ImportError(
                    "llama-cpp-python is required. Install with: pip install llama-cpp-python"
                ) from e

            model_path = self._config.models_dir / self._config.model_name

            if not model_path.exists():
                raise FileNotFoundError(
                    f"Model not found at {model_path}. "
                    f"Download from https://huggingface.co/Qwen/Qwen3-4B-GGUF"
                )

            print(f"Loading model: {model_path}")
            self._model = Llama(
                model_path=str(model_path),
                n_ctx=self._config.context_size,
                n_gpu_layers=self._config.gpu_layers,
                verbose=False,
            )
            print("Model loaded successfully")

        return self._model

    def generate(self, prompt: str) -> str:
        """Generate text from the model."""
        from llama_cpp import Llama

        model = self._get_model()
        assert isinstance(model, Llama)

        response = model(
            prompt,
            max_tokens=self._config.max_tokens,
            temperature=self._config.temperature,
            top_p=0.9,
            stop=["</note>"],
        )

        text = response["choices"][0]["text"]  # type: ignore
        return str(text)


# ============================================================================
# XML Parser
# ============================================================================

def parse_agent_output(output: str) -> AgentDecision:
    """Parse XML output from the agent into a decision."""
    default_decision = AgentDecision(
        action=ActionType.SLEEP,
        sleep_ms=1000,
        note="Failed to parse agent output",
    )

    # Remove <think> tags if present
    cleaned = re.sub(r"<think>[\s\S]*?</think>\s*", "", output).strip()

    # Extract action
    action_match = re.search(r"<action>\s*(RUN|SLEEP|STOP)\s*</action>", cleaned, re.IGNORECASE)
    if not action_match:
        print("Warning: Could not extract action from agent output")
        return default_decision

    action_str = action_match.group(1).upper()
    action = ActionType(action_str)

    # Extract command (for RUN)
    command: str | None = None
    if action == ActionType.RUN:
        cmd_match = re.search(r"<command>\s*([\s\S]*?)\s*</command>", cleaned, re.IGNORECASE)
        if cmd_match:
            command = cmd_match.group(1).strip()
        else:
            print("Warning: RUN action without command, defaulting to SLEEP")
            return AgentDecision(
                action=ActionType.SLEEP,
                sleep_ms=1000,
                note="RUN action without command",
            )

    # Extract sleepMs (for SLEEP)
    sleep_ms: int | None = None
    if action == ActionType.SLEEP:
        sleep_match = re.search(r"<sleepMs>\s*(\d+)\s*</sleepMs>", cleaned, re.IGNORECASE)
        sleep_ms = int(sleep_match.group(1)) if sleep_match else 1000

    # Extract note (optional)
    note_match = re.search(r"<note>\s*([\s\S]*?)\s*</note>", cleaned, re.IGNORECASE)
    note = note_match.group(1).strip() if note_match else None

    return AgentDecision(
        action=action,
        command=command,
        sleep_ms=sleep_ms,
        note=note,
    )


# ============================================================================
# Prompt Builder
# ============================================================================

def build_prompt(
    config: AutonomousConfig,
    current_dir: Path,
    shell_history: list[str],
    memory_records: list[IterationRecord],
    dir_listing: str,
) -> str:
    """Build the prompt for the agent."""
    memory_context = "\n".join(
        f"[Step {r.step}] {r.decision.action.value}"
        f"{': ' + r.decision.command if r.decision.command else ''} → "
        f"{'exit=' + str(r.result.exit_code) + ', ' + r.result.stdout[:100] if r.result else 'no result'}"
        for r in memory_records
    ) or "(no previous iterations)"

    history_context = "\n".join(shell_history[-5:]) if shell_history else "(no shell history yet)"

    return f"""You are an autonomous agent operating in a sandboxed directory.

## Your Environment
- Sandbox directory: {config.sandbox_dir}
- Current working directory: {current_dir}
- Files in current directory:
{dir_listing or "(empty or unable to list)"}

## Your Capabilities
- You can run shell commands (ls, cat, echo, touch, mkdir, cp, mv, grep, find, head, tail, wc, sort, uniq, date)
- You CANNOT run: networking commands, interpreters (python, node), process control (kill), or system commands
- All file operations are restricted to the sandbox directory

## Recent Memory
{memory_context}

## Recent Shell History
{history_context}

## Your Task
You are a curious autonomous agent. Your goal is to:
1. Explore your sandbox environment
2. Create and organize files as you see fit
3. Keep a log of your activities
4. Find interesting things to do within your constraints

Think about what would be useful or interesting to do next, then output your decision.

## Output Format
Respond with EXACTLY one of these XML structures:

To run a command:
<action>RUN</action>
<command>your shell command here</command>
<note>brief explanation of what you're doing</note>

To sleep/wait:
<action>SLEEP</action>
<sleepMs>milliseconds to sleep</sleepMs>
<note>why you're waiting</note>

To stop the agent:
<action>STOP</action>
<note>why you're stopping</note>

IMPORTANT: Output ONLY the XML tags. No other text before or after."""


# ============================================================================
# Autonomous Agent
# ============================================================================

class AutonomousAgent:
    """The main autonomous agent class."""

    def __init__(self, config: AutonomousConfig) -> None:
        self._config = config
        self._memory = AgentMemory()
        self._shell = ShellService(config)
        self._ai = LocalAIService(config)
        self._iteration_count = 0
        self._consecutive_failures = 0
        self._is_running = False

    async def initialize(self) -> None:
        """Initialize the agent."""
        # Ensure sandbox exists
        self._config.sandbox_dir.mkdir(parents=True, exist_ok=True)

        # Create welcome file
        welcome_path = self._config.sandbox_dir / "WELCOME.txt"
        if not welcome_path.exists():
            welcome_path.write_text(
                """Welcome, Autonomous Agent!

This is your sandbox. You can:
- Create files and directories
- Read and modify files
- Explore with ls, cat, find, grep, etc.

To stop the agent, create a file named "STOP" in this directory.

Have fun exploring!
"""
            )

        print(f"✓ Sandbox initialized: {self._config.sandbox_dir}")

    def _should_stop(self) -> bool:
        """Check if the agent should stop."""
        if self._config.stop_file.exists():
            print("STOP file detected, stopping agent")
            return True

        if self._iteration_count >= self._config.max_iterations:
            print(f"Max iterations ({self._config.max_iterations}) reached, stopping agent")
            return True

        if self._consecutive_failures >= self._config.max_consecutive_failures:
            print(
                f"Max consecutive failures ({self._config.max_consecutive_failures}) reached, "
                "stopping agent"
            )
            return True

        if os.environ.get("AUTONOMY_ENABLED") == "false":
            print("AUTONOMY_ENABLED=false, stopping agent")
            return True

        return False

    async def _get_directory_listing(self) -> str:
        """Get current directory listing."""
        result = await self._shell.execute_command("ls -la")
        if result.success:
            return result.stdout
        return f"(failed to list: {result.stderr})"

    async def _think(self) -> AgentDecision:
        """Generate the next decision using the AI model."""
        current_dir = self._shell.current_directory
        shell_history = self._shell.get_command_history(10)
        memory_records = self._memory.get_recent_records(self._config.memory_context_size)
        dir_listing = await self._get_directory_listing()

        prompt = build_prompt(
            self._config,
            current_dir,
            shell_history,
            memory_records,
            dir_listing,
        )

        response = self._ai.generate(prompt)

        # Add closing tag if truncated
        if "</note>" not in response:
            response += "</note>"

        return parse_agent_output(response)

    async def _act(self, decision: AgentDecision) -> ExecutionResult | None:
        """Execute the agent's decision."""
        if decision.action == ActionType.STOP:
            print(f"Agent decided to stop: {decision.note}")
            self._is_running = False
            return None

        if decision.action == ActionType.SLEEP:
            sleep_ms = decision.sleep_ms or 1000
            print(f"Agent sleeping for {sleep_ms}ms: {decision.note}")
            await asyncio.sleep(sleep_ms / 1000.0)
            return None

        if decision.action == ActionType.RUN and decision.command:
            if not is_command_allowed(decision.command):
                print(f"⚠ Blocked forbidden command: {decision.command}")
                return ExecutionResult(
                    success=False,
                    exit_code=1,
                    stdout="",
                    stderr="Command blocked by security policy",
                    cwd=str(self._shell.current_directory),
                )

            print(f"Executing: {decision.command}")
            result = await self._shell.execute_command(decision.command)

            if result.success:
                print(f"✓ Command succeeded (exit {result.exit_code})")
                if result.stdout:
                    preview = result.stdout[:200].replace("\n", " ")
                    print(f"  stdout: {preview}")
            else:
                print(f"✗ Command failed (exit {result.exit_code}): {result.stderr}")

            return result

        return None

    def _generate_summary(
        self,
        decision: AgentDecision,
        result: ExecutionResult | None,
    ) -> str:
        """Generate a summary of the iteration."""
        if decision.action == ActionType.STOP:
            return f"Stopped: {decision.note or 'agent decided to stop'}"

        if decision.action == ActionType.SLEEP:
            return f"Slept {decision.sleep_ms}ms: {decision.note or 'waiting'}"

        if decision.action == ActionType.RUN and result:
            status = "OK" if result.success else "FAIL"
            output = (result.stdout[:50] or result.stderr[:50] or "(no output)").replace("\n", " ")
            return f"{status}: {decision.command} → {output}"

        return "Unknown action"

    async def run(self) -> None:
        """Run the autonomous loop."""
        self._is_running = True

        # Setup signal handlers
        loop = asyncio.get_event_loop()

        def shutdown_handler() -> None:
            print("\nReceived shutdown signal, stopping agent...")
            self._is_running = False

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, shutdown_handler)

        print("Starting autonomous loop...")

        while self._is_running and not self._should_stop():
            self._iteration_count += 1
            iteration_id = str(uuid.uuid4())
            timestamp = time.time()

            print(f"\n{'='*60}")
            print(f"=== Iteration {self._iteration_count} ===")
            print(f"{'='*60}")

            decision: AgentDecision
            result: ExecutionResult | None = None

            # Think phase
            try:
                decision = await self._think()
                self._consecutive_failures = 0
            except Exception as e:
                print(f"✗ Think phase failed: {e}")
                self._consecutive_failures += 1
                decision = AgentDecision(
                    action=ActionType.SLEEP,
                    sleep_ms=self._config.loop_interval_ms * 2,
                    note=f"Think phase error: {e}",
                )

            # Act phase
            try:
                result = await self._act(decision)
            except Exception as e:
                print(f"✗ Act phase failed: {e}")
                self._consecutive_failures += 1
                result = ExecutionResult(
                    success=False,
                    exit_code=1,
                    stdout="",
                    stderr=f"Action error: {e}",
                    cwd=str(self._shell.current_directory),
                )

            # Store iteration record
            summary = self._generate_summary(decision, result)
            record = IterationRecord(
                id=iteration_id,
                timestamp=timestamp,
                step=self._iteration_count,
                prompt_summary=f"Iteration {self._iteration_count}",
                decision=decision,
                result=result,
                derived_summary=summary,
            )

            self._memory.store(record)

            # Inter-iteration delay
            if self._is_running and decision.action != ActionType.SLEEP:
                await asyncio.sleep(self._config.loop_interval_ms / 1000.0)

        print(f"\n{'='*60}")
        print(f"Autonomous loop ended after {self._iteration_count} iterations")
        print(f"{'='*60}")

        # Cleanup signal handlers
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


# ============================================================================
# Main Entry Point
# ============================================================================

def print_banner() -> None:
    """Print startup banner."""
    print("""
╔═══════════════════════════════════════════════════════════════════╗
║           AUTONOMOUS SELF-LOOPING AGENT (Python)                  ║
║                                                                   ║
║  A sandboxed agent that thinks locally, acts via shell,           ║
║  and remembers in ephemeral memory.                               ║
╚═══════════════════════════════════════════════════════════════════╝
""")


async def async_main() -> None:
    """Async main entry point."""
    print_banner()

    # Load configuration
    config = AutonomousConfig.from_env()

    print("Configuration:")
    print(f"  Sandbox:         {config.sandbox_dir}")
    print(f"  Models:          {config.models_dir}")
    print(f"  Model:           {config.model_name}")
    print(f"  Loop interval:   {config.loop_interval_ms}ms")
    print(f"  Max iterations:  {config.max_iterations}")
    print(f"  Agent ID:        {config.agent_id}")
    print()

    # Verify model exists
    model_path = config.models_dir / config.model_name
    if not model_path.exists():
        print(f"ERROR: Model not found at {model_path}")
        print("Please download a model first:")
        print("  wget -O ~/.eliza/models/Qwen3-4B-Q4_K_M.gguf \\")
        print("    https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf")
        sys.exit(1)

    # Create and run agent
    agent = AutonomousAgent(config)
    await agent.initialize()
    await agent.run()

    print("Agent shutdown complete")


def main() -> None:
    """Main entry point."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
