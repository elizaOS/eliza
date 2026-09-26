"""Native Eliza CLI inside Pier's task sandbox; Pier owns official grading."""
from __future__ import annotations

import hashlib
import json
import shlex
import uuid
from pathlib import Path
from urllib.parse import urlparse

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist
from benchmarks.swe_bench.native import parse_native_result, validate_native_trajectory


class ElizaAgent(BaseAgent):
    SUPPORTS_ATIF = False

    def __init__(self, *, runtime_bundle: str, runtime_sha256: str,
                 runtime_revision: str, provider: str = "cerebras",
                 provider_url: str = "https://api.cerebras.ai/v1",
                 extra_env: dict[str, str] | None = None, **kwargs):
        super().__init__(**kwargs)
        if not self.model_name:
            raise ValueError("An explicit model is required")
        if provider not in {"cerebras", "openai-compatible"}:
            raise ValueError("Unsupported native provider")
        parsed = urlparse(provider_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Provider URL must be HTTPS without embedded credentials")
        self.bundle = Path(runtime_bundle).resolve(strict=True)
        with self.bundle.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != runtime_sha256:
            raise ValueError("Native runtime bundle digest mismatch")
        self.bundle_digest = actual
        self.adapter_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        self.revision = runtime_revision
        self.provider = provider
        self.provider_url = provider_url
        self.domain = parsed.hostname
        self.extra_env = dict(extra_env or {})
        key_name = "CEREBRAS_API_KEY" if provider == "cerebras" else "OPENAI_API_KEY"
        if not self.extra_env.get(key_name):
            raise ValueError(f"Missing {key_name} in agent.env")
        self.key = self.extra_env[key_name]
        self.state_dir: str | None = None

    @staticmethod
    def name() -> str:
        return "eliza-native"

    def version(self) -> str:
        return self.revision

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=[self.domain])

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(self.bundle, "/tmp/eliza-runtime.tar")
        copied = await environment.exec("sha256sum /tmp/eliza-runtime.tar", user="root", timeout_sec=120)
        checksum = (copied.stdout or "").split()
        if copied.return_code != 0 or not checksum or checksum[0] != self.bundle_digest:
            raise RuntimeError("Runtime bundle changed or was corrupted during upload")
        result = await environment.exec(
            "mkdir -p /opt/eliza && tar -xf /tmp/eliza-runtime.tar -C /opt/eliza "
            "&& rm /tmp/eliza-runtime.tar && /opt/eliza/bin/bun --version",
            user="root", timeout_sec=300,
        )
        if result.return_code != 0:
            raise RuntimeError(f"Native runtime setup failed: {result.stderr}")
        if (result.stdout or "").strip() != "1.4.2":
            raise RuntimeError("Native runtime requires pinned Bun 1.4.2")
        home = await environment.exec('printf "%s" "$HOME"', timeout_sec=10)
        home_path = (home.stdout or "").strip()
        if home.return_code != 0 or not home_path.startswith("/") or home_path == "/":
            raise RuntimeError("Cannot identify a private native agent home")
        self.state_dir = home_path.rstrip("/") + "/.eliza-benchmark-state"
        private = await environment.exec("umask 077 && mkdir -p " + shlex.quote(self.state_dir), timeout_sec=10)
        if private.return_code != 0:
            raise RuntimeError("Cannot create private native runtime state")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if self.state_dir is None:
            raise RuntimeError("Native agent setup has not completed")
        trace_id = str(uuid.uuid4())
        task = {"id": environment.session_id, "type": "coding", "prompt": instruction,
                "context": {"workspace": "/app", "benchmark": "deepswe",
                            "execution_mode": "native_direct"}}
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        task_file = self.logs_dir / "task.json"
        task_file.write_text(json.dumps(task, indent=2) + "\n")
        await environment.upload_file(task_file, "/tmp/eliza-task.json")
        model = self.model_name
        for prefix in ("cerebras/", "openai/", "openai-compatible/"):
            if model.startswith(prefix):
                model = model.removeprefix(prefix)
                break
        env = {**self.extra_env,
               "ELIZA_STATE_DIR": self.state_dir,
               "ELIZA_CONFIG_PATH": self.state_dir + "/eliza.json",
               "CODING_TOOLS_WORKSPACE_ROOTS": "/app",
               "OPENAI_API_KEY": self.key, "OPENAI_BASE_URL": self.provider_url,
               "OPENAI_SMALL_MODEL": model, "OPENAI_LARGE_MODEL": model,
               "ELIZA_TRACE_ID": trace_id, "ELIZA_TRAJECTORY_LOGGING": "1", "LOG_LEVEL": "error"}
        if self.provider == "cerebras":
            env.update({"CEREBRAS_BASE_URL": self.provider_url,
                        "CEREBRAS_MODEL": model, "CEREBRAS_SMALL_MODEL": model,
                        "CEREBRAS_LARGE_MODEL": model})
        setting_keys = (
            "OPENAI_BASE_URL", "OPENAI_SMALL_MODEL", "OPENAI_LARGE_MODEL",
            "CEREBRAS_BASE_URL", "CEREBRAS_MODEL", "CEREBRAS_SMALL_MODEL",
            "CEREBRAS_LARGE_MODEL", "OPENAI_REASONING_EFFORT",
        )
        public_settings = {key: env[key] for key in setting_keys if key in env}
        runtime_config = self.logs_dir / "runtime-config.json"
        runtime_config.write_text(json.dumps({"env": {"vars": public_settings}}, indent=2) + "\n")
        await environment.upload_file(runtime_config, env["ELIZA_CONFIG_PATH"])
        command = shlex.join(["/opt/eliza/bin/bun", "--no-install",
                              "--conditions=eliza-source", "--no-env-file",
                              "/opt/eliza/packages/agent/src/bin.ts", "benchmark",
                              "--task", "/tmp/eliza-task.json"])
        context.metadata = {"runtime_revision": self.revision,
                            "runtime_bundle_sha256": self.bundle_digest,
                            "adapter_sha256": self.adapter_digest,
                            "execution_mode": "native_direct", "trace_id": trace_id,
                            "provider_url": self.provider_url, "api_model": model}
        failure = None
        result = None
        try:
            result = await environment.exec(
                "mkdir -p /logs/agent/eliza && " + command
                + " > /logs/agent/eliza/stdout.log 2> /logs/agent/eliza/stderr.log",
                cwd="/app", env=environment.agent_process_env(env),
            )
        except BaseException as exc:
            failure = exc
        if result is not None and result.return_code != 0:
            failure = RuntimeError(f"Native Eliza CLI exited {result.return_code}; see retained logs")
        for name in ("stdout.log", "stderr.log"):
            try:
                await environment.download_file(f"/logs/agent/eliza/{name}", self.logs_dir / name)
            except Exception:
                if failure is None:
                    raise
                self.logger.exception("Could not collect %s after failed native execution", name)
        try:
            await environment.download_dir(self.state_dir + "/trajectories", self.logs_dir / "trajectories")
        except Exception:
            if failure is None:
                raise
            self.logger.exception("Could not collect trajectory after failed native execution")
        if failure is not None:
            raise failure
        assert result is not None
        row = parse_native_result((self.logs_dir / "stdout.log").read_text(), task["id"])
        (self.logs_dir / "result.json").write_text(json.dumps(row, indent=2) + "\n")
        evidence = validate_native_trajectory(self.logs_dir / "trajectories", trace_id, task)
        context.metadata["native_trajectory"] = evidence
        # No self-awarded score or harness-generated commit: the separate official
        # verifier collects the agent's committed changes and determines reward.
