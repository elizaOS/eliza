"""Browser server process manager for Python."""

import asyncio
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


class BrowserProcessManager:
    """Manages the browser server process."""

    def __init__(self, server_port: int = 3456) -> None:
        self.server_port = server_port
        self.process: subprocess.Popen[bytes] | None = None
        self.is_running = False
        self.server_path = self._find_server()

    def _find_server(self) -> Path | None:
        """Find the browser server executable or script."""
        # Get the directory of this file
        this_dir = Path(__file__).parent.parent.parent

        # Possible server locations
        possible_paths = [
            # Stagehand server dist
            this_dir.parent.parent / "stagehand-server" / "dist" / "index.js",
            # Relative to plugin-browser
            this_dir.parent / "stagehand-server" / "dist" / "index.js",
            # From workspace root
            Path.cwd() / "plugins" / "plugin-browser" / "stagehand-server" / "dist" / "index.js",
        ]

        for path in possible_paths:
            if path.exists():
                logger.info(f"Found browser server at: {path}")
                return path

        # Check for TypeScript source as fallback
        ts_paths = [
            this_dir.parent.parent / "stagehand-server" / "src" / "index.ts",
            this_dir.parent / "stagehand-server" / "src" / "index.ts",
            Path.cwd() / "plugins" / "plugin-browser" / "stagehand-server" / "src" / "index.ts",
        ]

        for path in ts_paths:
            if path.exists():
                logger.warn(f"Found TypeScript source at: {path} - will need tsx to run")
                return path

        logger.error("Could not find browser server")
        logger.error(f"Searched paths: {possible_paths + ts_paths}")
        return None

    async def start(self) -> None:
        """Start the browser server process."""
        if self.is_running:
            logger.warning("Browser server is already running")
            return

        if not self.server_path:
            raise RuntimeError(
                "Browser server not found - please build stagehand-server:\n"
                "  cd plugins/plugin-browser/stagehand-server && npm install && npm run build"
            )

        env = {
            **os.environ,
            "BROWSER_SERVER_PORT": str(self.server_port),
            "NODE_ENV": os.environ.get("NODE_ENV", "production"),
        }

        # Copy relevant env vars
        for key in [
            "BROWSERBASE_API_KEY",
            "BROWSERBASE_PROJECT_ID",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "BROWSER_HEADLESS",
            "CAPSOLVER_API_KEY",
            "OLLAMA_BASE_URL",
            "OLLAMA_MODEL",
        ]:
            if key in os.environ:
                env[key] = os.environ[key]

        logger.info(f"Starting browser server from: {self.server_path}")

        if str(self.server_path).endswith(".ts"):
            # TypeScript source - use npx tsx
            cmd = ["npx", "tsx", str(self.server_path)]
        else:
            # JavaScript - use node directly
            cmd = ["node", str(self.server_path)]

        try:
            self.process = subprocess.Popen(
                cmd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.server_path.parent.parent,  # stagehand-server directory
            )

            # Start output readers
            asyncio.create_task(self._read_output())

            # Wait for server to be ready
            await self._wait_for_server()
            self.is_running = True
            logger.info("Browser server started successfully")

        except Exception as e:
            logger.error(f"Failed to start browser server: {e}")
            self.stop()
            raise

    async def _read_output(self) -> None:
        """Read and log server output."""
        if not self.process:
            return

        while self.process.poll() is None:
            if self.process.stdout:
                line = self.process.stdout.readline()
                if line:
                    logger.debug(f"[BrowserServer] {line.decode().strip()}")
            await asyncio.sleep(0.1)

    async def _wait_for_server(self, max_attempts: int = 30, delay: float = 1.0) -> None:
        """Wait for the server to be ready."""
        import websockets

        url = f"ws://localhost:{self.server_port}"

        for attempt in range(1, max_attempts + 1):
            try:
                async with websockets.connect(url):
                    logger.info("Browser server is ready")
                    return
            except Exception as e:
                if attempt < max_attempts:
                    logger.debug(f"Server not ready yet (attempt {attempt}/{max_attempts}): {e}")
                    await asyncio.sleep(delay)

                    # Check if process died
                    if self.process and self.process.poll() is not None:
                        stderr = self.process.stderr.read().decode() if self.process.stderr else ""
                        raise RuntimeError(f"Browser server process died. stderr: {stderr}")

        raise RuntimeError(f"Browser server failed to start after {max_attempts} attempts")

    def stop(self) -> None:
        """Stop the browser server process."""
        if not self.process:
            return

        logger.info("Stopping browser server")

        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()

        self.process = None
        self.is_running = False

    def __del__(self) -> None:
        """Cleanup on deletion."""
        self.stop()
