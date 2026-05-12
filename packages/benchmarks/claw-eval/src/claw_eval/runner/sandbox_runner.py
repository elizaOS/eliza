"""Docker container lifecycle management for sandbox execution.

New architecture: the agent loop stays on the host, the container only runs
a lightweight sandbox HTTP server.  The host-side dispatcher sends tool calls
to the container over HTTP.

Container lifecycle:
  1. start_container() — launch container, wait for /health
  2. (host runs agent loop, dispatching sandbox_* tools via HTTP)
  3. stop_container() — destroy container
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ..config import SandboxConfig


@dataclass
class ContainerHandle:
    """Reference to a running agent container."""

    container: Any  # docker Container object
    host_port: int  # sandbox service's mapped host port
    run_id: str
    sandbox_url: str  # "http://localhost:{host_port}"


class SandboxRunner:
    """Manages Docker containers for sandboxed agent evaluation."""

    def __init__(
        self,
        sandbox_config: SandboxConfig,
        *,
        image: str | None = None,
    ) -> None:
        try:
            import docker  # type: ignore[import-untyped]
        except ImportError:
            raise ImportError(
                "docker package is required for sandbox mode. "
                "Install with: pip install 'claw-eval[sandbox]'"
            ) from None

        self._config = sandbox_config
        self._image = image or sandbox_config.image

        kwargs: dict[str, Any] = {}
        if sandbox_config.docker_host:
            kwargs["base_url"] = sandbox_config.docker_host
        self._docker = docker.from_env(**kwargs)

    # ------------------------------------------------------------------
    # Container lifecycle
    # ------------------------------------------------------------------

    @staticmethod
    def _proxy_env() -> dict[str, str]:
        """Collect proxy environment variables from the host."""
        import os

        env = {}
        for key in (
            "http_proxy", "https_proxy", "no_proxy",
            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
        ):
            val = os.environ.get(key)
            if val:
                env[key] = val
        return env

    def start_container(self, *, run_id: str) -> ContainerHandle:
        """Launch an agent container and wait for the sandbox service.

        Returns a *ContainerHandle* with the sandbox HTTP URL that the
        host-side dispatcher should send ``sandbox_*`` tool calls to.
        """
        container = self._docker.containers.run(
            image=self._image,
            detach=True,
            name=f"claw-agent-{run_id}",
            mem_limit=self._config.memory_limit,
            nano_cpus=int(self._config.cpu_limit * 1e9),
            ports={f"{self._config.sandbox_port}/tcp": None},  # random host port
            labels={"app": "claw-eval", "role": "agent", "run_id": run_id},
            environment=self._proxy_env(),
        )

        host_port = self._get_mapped_port(container)
        sandbox_url = f"http://localhost:{host_port}"
        self._wait_healthy(f"{sandbox_url}/health")

        print(f"[sandbox] Container claw-agent-{run_id} started at {sandbox_url}")
        return ContainerHandle(
            container=container,
            host_port=host_port,
            run_id=run_id,
            sandbox_url=sandbox_url,
        )

    def stop_container(self, handle: ContainerHandle) -> None:
        """Stop and remove a running agent container."""
        try:
            handle.container.remove(force=True)
            print(f"[sandbox] Container claw-agent-{handle.run_id} removed")
        except Exception as exc:
            print(f"[sandbox] Warning: failed to remove container: {exc}")

    def cleanup_all(self) -> int:
        """Remove all claw-eval agent containers (e.g. after a crash)."""
        containers = self._docker.containers.list(
            all=True, filters={"label": ["app=claw-eval"]}
        )
        for c in containers:
            c.remove(force=True)
        return len(containers)

    # ------------------------------------------------------------------
    # File injection
    # ------------------------------------------------------------------

    @staticmethod
    def _inject_file_list(
        handle: ContainerHandle,
        file_list: list[str],
        root: "Path",
        *,
        label: str = "inject",
    ) -> int:
        """Push a list of files into a running container.

        Shared implementation for both :meth:`inject_files` (pre-loop) and
        :meth:`inject_grader_files` (post-loop).

        Returns the number of files successfully injected.
        """
        import base64
        import mimetypes
        from pathlib import Path

        import httpx

        if not file_list:
            return 0

        client = httpx.Client(timeout=30.0)
        injected = 0

        _TEXT_MIMES = {
            "text/plain", "text/csv", "text/markdown", "text/html",
            "text/xml", "application/json", "application/xml",
            "application/yaml", "application/x-yaml", "application/javascript",
        }
        _TEXT_EXTENSIONS = {
            ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml",
            ".html", ".htm", ".js", ".ts", ".py", ".sh", ".bash",
            ".cfg", ".ini", ".toml", ".log", ".sql", ".r", ".rmd",
        }

        # Project root for cross-task fixture references (e.g. "tasks/T14/fixtures/...")
        # Walk up from the resolved task dir to find the directory containing "tasks/"
        project_root = root.resolve().parent  # fallback
        _pr = root.resolve()
        while _pr.parent != _pr:
            if (_pr / "tasks").is_dir():
                project_root = _pr
                break
            _pr = _pr.parent

        try:
            for rel_path in file_list:
                src = root / rel_path
                if not src.exists():
                    # Cross-task reference: try resolving from project root
                    alt = project_root / rel_path
                    if alt.exists():
                        src = alt
                    else:
                        print(f"[sandbox] {label}: skipping {rel_path} (not found at {src} or {alt})")
                        continue

                container_path = f"/workspace/{rel_path}"
                mime, _ = mimetypes.guess_type(str(src))
                ext = src.suffix.lower()
                is_text = (
                    mime in _TEXT_MIMES
                    or (mime is not None and mime.startswith("text/"))
                    or (mime is None and ext in _TEXT_EXTENSIONS)
                )

                if is_text:
                    content = src.read_text(encoding="utf-8", errors="replace")
                    resp = client.post(
                        f"{handle.sandbox_url}/write",
                        json={"path": container_path, "content": content},
                    )
                else:
                    b64 = base64.b64encode(src.read_bytes()).decode("ascii")
                    resp = client.post(
                        f"{handle.sandbox_url}/write_b64",
                        json={"path": container_path, "content_b64": b64},
                    )

                if resp.status_code < 400:
                    injected += 1
                else:
                    print(f"[sandbox] {label}: failed {rel_path} — {resp.status_code} {resp.text[:100]}")
        finally:
            client.close()

        if injected:
            print(f"[sandbox] {label}: {injected}/{len(file_list)} files into container")
        return injected

    @staticmethod
    def _resolve_task_root(task, task_dir: str | None) -> "Path":
        """Resolve the root directory for task-relative file paths."""
        from pathlib import Path

        if task_dir:
            return Path(task_dir)
        if getattr(task, "task_file", None):
            return Path(task.task_file).parent
        return Path.cwd()

    @staticmethod
    def inject_files(
        handle: ContainerHandle,
        task,
        *,
        task_dir: str | None = None,
    ) -> int:
        """Push task-declared files into a running container via its /write endpoint.

        Which files to inject is determined by (in priority order):
        1. ``task.sandbox_files`` — explicit list in task.yaml
        2. Fallback: ``task.environment.fixtures`` — the fixture manifest

        Paths are relative to *task_dir* (the directory containing task.yaml).
        Inside the container they land under ``/workspace/<relative_path>``.

        Binary files (images, PDFs, etc.) are base64-encoded for transport
        and decoded by a dedicated ``/write_b64`` endpoint.  Text files go
        through the existing ``/write`` endpoint.

        Returns the number of files successfully injected.
        """
        file_list: list[str] = list(task.sandbox_files) if task.sandbox_files else []
        if not file_list:
            file_list = list(getattr(task.environment, "fixtures", []))
        if not file_list:
            return 0

        root = SandboxRunner._resolve_task_root(task, task_dir)
        return SandboxRunner._inject_file_list(handle, file_list, root, label="inject")

    @staticmethod
    def inject_grader_files(
        handle: ContainerHandle,
        task,
        *,
        task_dir: str | None = None,
    ) -> int:
        """Push grader-only files into container AFTER the agent loop.

        These files (e.g., verify scripts with embedded answers) must not
        be visible to the agent during its run.  They are injected just
        before ``_collect_env_snapshot`` runs.

        Returns the number of files successfully injected.
        """
        file_list: list[str] = list(task.sandbox_grader_files) if getattr(task, "sandbox_grader_files", None) else []
        if not file_list:
            return 0

        root = SandboxRunner._resolve_task_root(task, task_dir)
        return SandboxRunner._inject_file_list(handle, file_list, root, label="grader-inject")

    # ------------------------------------------------------------------
    # Image management
    # ------------------------------------------------------------------

    def build_image(
        self,
        context_path: str = ".",
        *,
        dockerfile: str = "Dockerfile.agent",
    ) -> str:
        """Build the agent container image.

        Args:
            context_path: Docker build context directory.
            dockerfile: Dockerfile name relative to context_path.
        """
        from pathlib import Path

        context_path_abs = str(Path(context_path).resolve())
        print(f"[sandbox] Building image {self._image} from {context_path_abs} (dockerfile={dockerfile}) ...")
        image, logs = self._docker.images.build(
            path=context_path_abs,
            dockerfile=dockerfile,
            tag=self._image,
            rm=True,
        )
        for chunk in logs:
            if "stream" in chunk:
                line = chunk["stream"].rstrip()
                if line:
                    print(f"  {line}")
        print(f"[sandbox] Image built: {image.tags}")
        return self._image

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_mapped_port(self, container) -> int:
        """Resolve the dynamically-assigned host port for the sandbox service."""
        container.reload()
        port_key = f"{self._config.sandbox_port}/tcp"
        bindings = container.ports.get(port_key)
        if not bindings:
            raise RuntimeError(
                f"No port binding found for {port_key}. "
                f"Container ports: {container.ports}"
            )
        return int(bindings[0]["HostPort"])

    def _wait_healthy(self, url: str, timeout: int = 15) -> None:
        """Poll the sandbox /health endpoint until it responds 200."""
        import httpx

        deadline = time.monotonic() + timeout
        last_exc: Exception | None = None
        while time.monotonic() < deadline:
            try:
                resp = httpx.get(url, timeout=2)
                if resp.status_code == 200:
                    return
            except Exception as exc:
                last_exc = exc
            time.sleep(0.3)
        raise RuntimeError(
            f"Sandbox service not ready at {url} after {timeout}s"
            + (f": {last_exc}" if last_exc else "")
        )
