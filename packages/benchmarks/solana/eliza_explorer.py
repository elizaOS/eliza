from __future__ import annotations

import asyncio
import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


SOLANA_DIR = Path(__file__).resolve().parent
GYM_ENV_DIR = SOLANA_DIR / "solana-gym-env"
SKILL_RUNNER_DIR = GYM_ENV_DIR / "voyager" / "skill_runner"


def _resolve_gym_path(path: str | os.PathLike[str]) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    gym_relative = GYM_ENV_DIR / candidate
    if gym_relative.exists() or str(candidate).startswith("voyager/"):
        return gym_relative
    return candidate


def _last_json_line(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        line = line.strip()
        if not line:
            continue
        return json.loads(line)
    return {
        "success": False,
        "reason": "Skill runner did not emit JSON output.",
        "serialized_tx": None,
    }


def run_typescript_skill(
    code: str,
    agent_pubkey: str,
    latest_blockhash: str,
    code_file: str | os.PathLike[str] | None = None,
    timeout: int = 30000,
) -> dict[str, Any]:
    """Write and execute a Solana TypeScript skill with the bundled runner."""
    target = _resolve_gym_path(code_file or "voyager/skill_runner/code_loop_code.ts")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(code, encoding="utf-8")

    command = [
        "bun",
        "run",
        "./runSkill.ts",
        str(target),
        str(timeout),
        agent_pubkey,
        latest_blockhash,
    ]
    try:
        result = subprocess.run(
            command,
            cwd=SKILL_RUNNER_DIR,
            capture_output=True,
            text=True,
            check=True,
            encoding="utf-8",
        )
        return _last_json_line(result.stdout)
    except subprocess.CalledProcessError as exc:
        try:
            parsed = _last_json_line(exc.stdout or "")
        except json.JSONDecodeError:
            parsed = {
                "success": False,
                "reason": "Skill runner error",
                "serialized_tx": None,
            }
        if exc.stderr:
            parsed["stderr"] = exc.stderr
        return parsed
    except FileNotFoundError:
        return {
            "success": False,
            "reason": "Bun command not found. Make sure Bun is installed and in your PATH.",
            "serialized_tx": None,
        }


class ElizaExplorer:
    """Solana benchmark explorer facade used by registry/orchestrator wiring."""

    code_pattern = re.compile(r"```(?:javascript|js|typescript|ts)(.*?)```", re.DOTALL)

    def __init__(
        self,
        model_name: str = "anthropic/claude-sonnet-4.6",
        run_index: int = 0,
        max_messages: int = 50,
        checkpoint_dir: str = "ckpt/eliza",
        resume: bool = False,
        verbose: bool = True,
        code_file: str | None = None,
        environment_config: str | None = None,
        output_dir: str | None = None,
    ):
        self.model_name = model_name
        self.run_index = run_index
        self.max_messages = max_messages
        self.checkpoint_dir = checkpoint_dir
        self.resume = resume
        self.verbose = verbose
        self.code_file = code_file or "voyager/skill_runner/code_loop_code.ts"
        self.environment_config_path = environment_config
        self.output_dir = Path(output_dir or os.getenv("OUTPUT_DIR", "")).expanduser() if (output_dir or os.getenv("OUTPUT_DIR")) else None
        self.env_config = self._load_environment_config(environment_config)
        self._timeout_ms = int((self.env_config or {}).get("timeout", 30000))
        self._llm = None

        self.run_id = f"eliza_{datetime.now().strftime('%y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        self.message_count = 0
        self.messages: list[dict[str, str]] = []
        self.metrics: dict[str, Any] = {
            "model": model_name,
            "run_index": run_index,
            "run_id": self.run_id,
            "start_time": datetime.now().isoformat(),
            "environment_config": environment_config,
            "messages": [],
            "cumulative_rewards": [],
            "programs_discovered": {},
            "instructions_by_program": {},
            "phase_transitions": [],
            "errors": [],
        }

    def _load_environment_config(self, config_path: str | None) -> dict[str, Any] | None:
        if not config_path:
            return None
        try:
            return json.loads(_resolve_gym_path(config_path).read_text(encoding="utf-8"))
        except Exception:
            return None

    def _ensure_llm(self):
        if self._llm is not None:
            return self._llm
        provider = os.getenv("BENCHMARK_MODEL_PROVIDER", "").strip().lower()
        if not provider:
            if os.getenv("GROQ_API_KEY"):
                provider = "groq"
            elif os.getenv("OPENROUTER_API_KEY"):
                provider = "openrouter"
            elif os.getenv("OPENAI_API_KEY"):
                provider = "openai"
            else:
                provider = "openrouter"
        provider_config = {
            "groq": ("GROQ_API_KEY", "https://api.groq.com/openai/v1"),
            "openrouter": ("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"),
            "openai": ("OPENAI_API_KEY", os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")),
        }
        if provider not in provider_config:
            raise RuntimeError("Solana explorer supports provider=openai, groq, or openrouter")
        key_var, base_url = provider_config[provider]
        api_key = os.getenv(key_var)
        if not api_key:
            raise RuntimeError(f"API key required: set {key_var} for provider={provider}")
        try:
            from langchain_openai import ChatOpenAI
        except ImportError as exc:
            raise RuntimeError("langchain_openai is required to run the Solana explorer") from exc
        self._llm = ChatOpenAI(
            base_url=base_url,
            model=self.model_name,
            api_key=api_key,
            temperature=0.7,
        )
        return self._llm

    def save_checkpoint(self) -> Path:
        metrics_dir = self.output_dir or (GYM_ENV_DIR / "metrics")
        metrics_dir.mkdir(parents=True, exist_ok=True)
        cumulative = self.metrics.get("cumulative_rewards")
        if isinstance(cumulative, list) and cumulative:
            self.metrics["final_reward"] = cumulative[-1]
        else:
            self.metrics.setdefault("final_reward", 0)
        programs = self.metrics.get("programs_discovered")
        self.metrics["final_programs"] = len(programs) if isinstance(programs, dict) else 0
        path = metrics_dir / f"{self.run_id}_metrics.json"
        path.write_text(json.dumps(self.metrics, indent=2), encoding="utf-8")
        return path

    async def run(self) -> Path:
        if self.max_messages <= 0:
            self.save_checkpoint()
            return GYM_ENV_DIR / "metrics" / f"{self.run_id}_metrics.json"

        if str(GYM_ENV_DIR) not in sys.path:
            sys.path.insert(0, str(GYM_ENV_DIR))
        from voyager.surfpool_env import SurfpoolEnv, _surfpool_validator
        from eliza_adapter.solana import ElizaBridgeSolanaExplorer

        old_cwd = Path.cwd()
        os.chdir(GYM_ENV_DIR)
        try:
            runner = ElizaBridgeSolanaExplorer(
                model_name=self.model_name,
                run_index=self.run_index,
                max_messages=self.max_messages,
                code_file=self.code_file,
                environment_config=self.environment_config_path,
            )

            allowed_programs = []
            if runner.env_config and "reward_config" in runner.env_config:
                allowed_programs = runner.env_config["reward_config"].get("allowed_programs", [])

            use_external_surfpool = os.getenv("USE_EXTERNAL_SURFPOOL", "false").lower() == "true"
            if use_external_surfpool:
                env = SurfpoolEnv(allowed_programs=allowed_programs, use_external_surfpool=True)
                await env.reset()
                try:
                    data = await runner.run(env)
                    metrics_path = GYM_ENV_DIR / "metrics" / f"{runner.run_id}_metrics.json"
                finally:
                    await env.close()
            else:
                async with _surfpool_validator("https://api.mainnet-beta.solana.com"):
                    env = SurfpoolEnv(allowed_programs=allowed_programs, use_external_surfpool=True)
                    await env.reset()
                    try:
                        data = await runner.run(env)
                        metrics_path = GYM_ENV_DIR / "metrics" / f"{runner.run_id}_metrics.json"
                    finally:
                        await env.close()

            if not metrics_path.exists():
                metrics_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            data = json.loads(metrics_path.read_text(encoding="utf-8"))
            cumulative = data.get("cumulative_rewards")
            data["final_reward"] = cumulative[-1] if isinstance(cumulative, list) and cumulative else 0
            programs = data.get("programs_discovered")
            data["final_programs"] = len(programs) if isinstance(programs, dict) else 0
            metrics_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            if self.output_dir and metrics_path.parent != self.output_dir:
                target = self.output_dir / metrics_path.name
                target.write_text(json.dumps(data, indent=2), encoding="utf-8")
                metrics_path = target
            return metrics_path
        finally:
            os.chdir(old_cwd)


async def async_main() -> None:
    parser = argparse.ArgumentParser(description="Run the Solana instruction discovery benchmark")
    parser.add_argument("--output-dir", default=os.getenv("OUTPUT_DIR"), help="Directory for metrics JSON")
    args = parser.parse_args()
    explorer = ElizaExplorer(
        model_name=os.getenv("MODEL_NAME", os.getenv("BENCHMARK_MODEL_NAME", "openai/gpt-oss-120b")),
        max_messages=int(os.getenv("MAX_MESSAGES", "50")),
        run_index=int(os.getenv("RUN_INDEX", "0")),
        code_file=os.getenv("CODE_FILE"),
        environment_config=os.getenv("ENVIRONMENT_CONFIG"),
        output_dir=args.output_dir,
    )
    await explorer.run()


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
