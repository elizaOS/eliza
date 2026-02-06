"""GmailWatchService – manages the ``gog gmail watch serve`` child process.

On start:
  1. Reads hooks.gmail config from character settings
  2. Spawns ``gog gmail watch serve`` as a child process
  3. Sets up auto-renew timer (default every 6 hours)
  4. The child process receives Pub/Sub pushes and forwards them
     to the webhooks plugin's ``/hooks/gmail`` endpoint

On stop:
  1. Kills the child process
  2. Clears the auto-renew timer
"""

import asyncio
import logging
import shutil
import signal
from asyncio.subprocess import Process

from elizaos_plugin_gmail_watch.config import GmailWatchConfig

logger = logging.getLogger(__name__)

MAX_RESTART_ATTEMPTS = 10
INITIAL_RESTART_DELAY_S = 10.0
MAX_RESTART_DELAY_S = 300.0  # 5 minutes


def calculate_backoff_delay(attempt: int) -> float:
    """Calculate exponential backoff delay for a given attempt number.

    Args:
        attempt: 1-based restart attempt number.

    Returns:
        The delay in seconds, clamped to ``MAX_RESTART_DELAY_S``.
    """
    if attempt < 1:
        return INITIAL_RESTART_DELAY_S
    delay = INITIAL_RESTART_DELAY_S * (2 ** (attempt - 1))
    return min(delay, MAX_RESTART_DELAY_S)


def find_gog_binary() -> str | None:
    """Locate the ``gog`` binary on the system PATH.

    Returns:
        The full path to the binary, or ``None`` if not found.
    """
    return shutil.which("gog")


def build_serve_args(config: GmailWatchConfig) -> list[str]:
    """Build the argument list for ``gog gmail watch serve``.

    Args:
        config: The resolved Gmail Watch configuration.

    Returns:
        A list of CLI arguments (excluding the ``gog`` binary itself).
    """
    args: list[str] = [
        "gmail", "watch", "serve",
        "--account", config.account,
        "--bind", config.serve.bind,
        "--port", str(config.serve.port),
        "--path", config.serve.path,
        "--hook-url", config.hook_url,
    ]

    if config.hook_token:
        args.extend(["--hook-token", config.hook_token])
    if config.push_token:
        args.extend(["--token", config.push_token])
    if config.include_body:
        args.append("--include-body")
    if config.max_bytes:
        args.extend(["--max-bytes", str(config.max_bytes)])

    return args


def build_renew_args(config: GmailWatchConfig) -> list[str]:
    """Build the argument list for ``gog gmail watch start`` (renewal).

    Args:
        config: The resolved Gmail Watch configuration.

    Returns:
        A list of CLI arguments (excluding the ``gog`` binary itself).
    """
    args: list[str] = [
        "gmail", "watch", "start",
        "--account", config.account,
        "--label", config.label,
    ]

    if config.topic:
        args.extend(["--topic", config.topic])

    return args


class GmailWatchService:
    """Manages the ``gog gmail watch serve`` child process.

    The service spawns a long-running ``gog`` process that receives
    Google Pub/Sub push notifications, fetches message content via
    the Gmail API, and forwards structured payloads to the webhooks
    plugin.  It also auto-renews the Gmail watch on a configurable
    interval and restarts the child process with exponential backoff
    on unexpected exits.
    """

    def __init__(self, config: GmailWatchConfig) -> None:
        self._config = config
        self._process: Process | None = None
        self._renew_task: asyncio.Task[None] | None = None
        self._restart_attempts = 0
        self._running = False

    # -- public properties ---------------------------------------------------

    @property
    def config(self) -> GmailWatchConfig:
        """The resolved configuration."""
        return self._config

    @property
    def is_running(self) -> bool:
        """Whether the service is currently active."""
        return self._running

    @property
    def restart_attempts(self) -> int:
        """Number of consecutive restart attempts since last healthy launch."""
        return self._restart_attempts

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        """Start the Gmail Watch service.

        This locates the ``gog`` binary, spawns the watcher process,
        and starts the periodic renewal timer.
        """
        valid, err = self._config.validate_config()
        if not valid:
            logger.error("[GmailWatch] Invalid configuration: %s", err)
            return

        gog_path = find_gog_binary()
        if gog_path is None:
            logger.warning(
                "[GmailWatch] gog binary not found in PATH. "
                "Install gogcli: https://gogcli.sh/"
            )
            return

        await self._spawn_watcher()
        self._start_renew_timer()
        self._running = True

        logger.info(
            "[GmailWatch] Started for %s (renew every %dm)",
            self._config.account,
            self._config.renew_every_minutes,
        )

    async def stop(self) -> None:
        """Stop the Gmail Watch service.

        Kills the child process and cancels the renewal timer.
        """
        self._running = False

        if self._renew_task is not None:
            self._renew_task.cancel()
            try:
                await self._renew_task
            except asyncio.CancelledError:
                pass
            self._renew_task = None

        if self._process is not None:
            try:
                self._process.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass
            await self._process.wait()
            self._process = None

        logger.info("[GmailWatch] Stopped")

    # -- internals -----------------------------------------------------------

    async def _spawn_watcher(self) -> None:
        """Spawn the ``gog gmail watch serve`` child process."""
        args = build_serve_args(self._config)
        logger.debug("[GmailWatch] Spawning: gog %s", " ".join(args))

        self._process = await asyncio.create_subprocess_exec(
            "gog",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Reset restart counter on successful spawn
        self._restart_attempts = 0

        # Start reading stdout/stderr in background
        asyncio.ensure_future(self._read_stream(self._process.stdout, "stdout"))
        asyncio.ensure_future(self._read_stream(self._process.stderr, "stderr"))

        # Monitor for unexpected exit
        asyncio.ensure_future(self._monitor_process())

    async def _read_stream(
        self,
        stream: asyncio.StreamReader | None,
        label: str,
    ) -> None:
        """Read lines from a subprocess stream and log them."""
        if stream is None:
            return

        while True:
            line_bytes = await stream.readline()
            if not line_bytes:
                break
            line = line_bytes.decode(errors="replace").rstrip()
            if line:
                if label == "stderr":
                    logger.warning("[GmailWatch:%s] %s", label, line)
                else:
                    logger.debug("[GmailWatch:%s] %s", label, line)

    async def _monitor_process(self) -> None:
        """Wait for the child process to exit and optionally auto-restart."""
        if self._process is None:
            return

        returncode = await self._process.wait()
        logger.warning(
            "[GmailWatch] Child process exited (code=%s)", returncode
        )
        self._process = None

        if not self._running:
            return

        self._restart_attempts += 1

        if self._restart_attempts > MAX_RESTART_ATTEMPTS:
            logger.error(
                "[GmailWatch] Max restart attempts (%d) reached. "
                "Giving up. Check gog configuration and restart the service manually.",
                MAX_RESTART_ATTEMPTS,
            )
            return

        delay = calculate_backoff_delay(self._restart_attempts)
        logger.info(
            "[GmailWatch] Auto-restarting in %.0fs (attempt %d/%d)",
            delay,
            self._restart_attempts,
            MAX_RESTART_ATTEMPTS,
        )

        await asyncio.sleep(delay)

        if self._running:
            await self._spawn_watcher()

    def _start_renew_timer(self) -> None:
        """Start the periodic watch renewal timer."""
        interval_s = self._config.renew_every_minutes * 60

        async def _renew_loop() -> None:
            while True:
                await asyncio.sleep(interval_s)
                await self._renew_watch()

        self._renew_task = asyncio.ensure_future(_renew_loop())

    async def _renew_watch(self) -> None:
        """Renew the Gmail watch by running ``gog gmail watch start``."""
        logger.info("[GmailWatch] Renewing watch for %s", self._config.account)

        gog_path = find_gog_binary()
        if gog_path is None:
            logger.warning("[GmailWatch] gog binary not found, cannot renew")
            return

        args = build_renew_args(self._config)
        proc = await asyncio.create_subprocess_exec(
            "gog",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout_data, stderr_data = await proc.communicate()

        if stdout_data:
            logger.debug(
                "[GmailWatch:renew:stdout] %s",
                stdout_data.decode(errors="replace").strip(),
            )
        if stderr_data:
            logger.warning(
                "[GmailWatch:renew:stderr] %s",
                stderr_data.decode(errors="replace").strip(),
            )

        if proc.returncode == 0:
            logger.info("[GmailWatch] Watch renewed successfully")
        else:
            logger.warning(
                "[GmailWatch] Watch renewal exited with code %s",
                proc.returncode,
            )
