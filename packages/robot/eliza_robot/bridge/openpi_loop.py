"""Autonomous OpenPI policy loop with integrated perception.

Runs the perception pipeline in a background thread and queries an OpenPI
policy server at a fixed rate, sending actions to the AiNex bridge server.

Usage:
    python3 -m eliza_robot.bridge.openpi_loop --backend mock
    python3 -m eliza_robot.bridge.openpi_loop --backend ros_real --camera-device 0
    python3 -m eliza_robot.bridge.openpi_loop --policy-url http://localhost:8000/infer
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import threading
import time
from typing import TYPE_CHECKING, Any

from eliza_robot.bridge.openpi_adapter import (
    action_to_bridge_commands,
    build_observation,
    decode_action,
    default_perception,
    observation_to_dict,
)
from eliza_robot.bridge.perception import PerceptionAggregator
from eliza_robot.interfaces import AinexPerceptionObservation

# Perception pipeline is loaded lazily because eliza_robot.perception.{config,
# frame_source, pipeline} are still being filled in (W2.4b). Importing them at
# module load would break `import eliza_robot.bridge.openpi_loop` for callers
# (like tests) that don't actually start a perception thread.
if TYPE_CHECKING:
    from eliza_robot.perception.config import PipelineConfig
    from eliza_robot.perception.frame_source import FrameSource, OpenCVSource
    from eliza_robot.perception.pipeline import PerceptionPipeline

logger = logging.getLogger(__name__)


class OpenPIPolicyLoop:
    """Autonomous policy execution loop with perception integration.

    Manages the lifecycle of:
    - PerceptionPipeline (background thread processing camera frames)
    - PerceptionAggregator (merges perception + robot telemetry)
    - Policy query loop (calls OpenPI server at fixed Hz)
    - Action dispatch (sends commands to bridge backend)
    """

    def __init__(
        self,
        policy_url: str = "http://localhost:8000/infer",
        hz: float = 10.0,
        camera_device: int = 0,
        camera_width: int = 640,
        camera_height: int = 480,
        enable_perception: bool = True,
        pipeline_config: PipelineConfig | None = None,
    ) -> None:
        self._policy_url = policy_url
        self._hz = hz
        self._camera_device = camera_device
        self._camera_width = camera_width
        self._camera_height = camera_height
        self._enable_perception = enable_perception

        # Perception components
        self._aggregator = PerceptionAggregator()
        self._pipeline: PerceptionPipeline | None = None
        self._pipeline_thread: threading.Thread | None = None
        self._frame_source: FrameSource | None = None

        if enable_perception:
            # Lazy import — eliza_robot.perception.pipeline depends on
            # calibration/world_model modules that land in W2.4b.
            from eliza_robot.perception.pipeline import PerceptionPipeline

            self._pipeline = PerceptionPipeline(config=pipeline_config)
            self._pipeline.connect_aggregator(self._aggregator)

        # State
        self._running = False
        self._step = 0
        self._task = ""
        self._send_command_fn: Any = None

    @property
    def aggregator(self) -> PerceptionAggregator:
        return self._aggregator

    @property
    def pipeline(self) -> PerceptionPipeline | None:
        return self._pipeline

    @property
    def step_count(self) -> int:
        return self._step

    @property
    def is_running(self) -> bool:
        return self._running

    def update_telemetry(self, data: dict[str, Any]) -> None:
        """Feed robot telemetry into the aggregator."""
        self._aggregator.update_telemetry(data)

    def start_perception(self, source: FrameSource | None = None) -> None:
        """Start the perception pipeline in a background thread.

        Args:
            source: Optional custom frame source. Defaults to OpenCVSource.
        """
        if self._pipeline is None:
            logger.warning("Perception disabled, skipping start_perception")
            return
        if self._pipeline_thread is not None and self._pipeline_thread.is_alive():
            logger.warning("Perception pipeline already running")
            return

        if source is None:
            from eliza_robot.perception.frame_source import OpenCVSource

            source = OpenCVSource(
                device=self._camera_device,
                width=self._camera_width,
                height=self._camera_height,
            )
        self._frame_source = source

        def _run_pipeline():
            try:
                self._pipeline.run(self._frame_source)
            except Exception:
                logger.exception("Perception pipeline error")

        self._pipeline_thread = threading.Thread(
            target=_run_pipeline, daemon=True, name="perception-pipeline"
        )
        self._pipeline_thread.start()
        logger.info("Perception pipeline started on device %d", self._camera_device)

    def stop_perception(self) -> None:
        """Stop the perception pipeline."""
        if self._frame_source is not None:
            self._frame_source.release()
            self._frame_source = None
        self._pipeline_thread = None

    def get_observation(
        self,
        task: str = "",
        camera_frame: str = "",
    ) -> dict[str, Any]:
        """Build an OpenPI observation payload from current perception state.

        Returns:
            Dict ready to POST to the OpenPI server.
        """
        snapshot = self._aggregator.snapshot(
            language_instruction=task,
            camera_frame=camera_frame,
        )
        payload = build_observation(snapshot)
        return observation_to_dict(payload)

    def process_action(self, raw_action: dict[str, Any]) -> list[dict[str, Any]]:
        """Decode an OpenPI action response into bridge commands.

        Returns:
            List of bridge command dicts.
        """
        action = decode_action(raw_action)
        return action_to_bridge_commands(action)

    async def run_loop(
        self,
        task: str = "",
        max_steps: int = 10000,
        send_command_fn: Any = None,
        query_policy_fn: Any = None,
    ) -> dict[str, Any]:
        """Run the autonomous policy loop.

        Args:
            task: Language instruction for the policy.
            max_steps: Maximum number of steps before stopping.
            send_command_fn: Async callable(command_dict) -> None.
                Sends a bridge command. If None, commands are logged only.
            query_policy_fn: Async callable(observation_dict) -> action_dict.
                Queries the OpenPI policy server. If None, uses HTTP POST.

        Returns:
            Summary dict with step count and status.
        """
        self._running = True
        self._step = 0
        self._task = task
        period = 1.0 / self._hz

        if query_policy_fn is None:
            query_policy_fn = self._default_query_policy

        logger.info(
            "Policy loop started: task=%r, hz=%.1f, max_steps=%d",
            task, self._hz, max_steps,
        )

        try:
            while self._running and self._step < max_steps:
                t0 = time.monotonic()

                # Build observation
                obs = self.get_observation(task=task)

                # Query policy
                try:
                    raw_action = await query_policy_fn(obs)
                except Exception:
                    logger.exception("Policy query failed at step %d", self._step)
                    await asyncio.sleep(period)
                    continue

                # Decode and dispatch
                commands = self.process_action(raw_action)
                if send_command_fn is not None:
                    for cmd in commands:
                        try:
                            await send_command_fn(cmd)
                        except Exception:
                            logger.exception("Command dispatch failed at step %d", self._step)

                self._step += 1

                # Maintain target Hz
                elapsed = time.monotonic() - t0
                sleep_time = period - elapsed
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            logger.info("Policy loop cancelled at step %d", self._step)
        finally:
            self._running = False

        status = "max_steps" if self._step >= max_steps else "stopped"
        logger.info("Policy loop ended: status=%s, steps=%d", status, self._step)

        return {
            "status": status,
            "steps": self._step,
            "task": task,
        }

    def stop(self) -> None:
        """Signal the policy loop to stop."""
        self._running = False

    async def _default_query_policy(self, obs: dict[str, Any]) -> dict[str, Any]:
        """Default HTTP POST to OpenPI policy server."""
        try:
            import aiohttp
        except ImportError:
            raise RuntimeError(
                "aiohttp required for HTTP policy queries. "
                "Install with: pip install aiohttp"
            )
        async with aiohttp.ClientSession() as session:
            async with session.post(
                self._policy_url,
                json=obs,
                timeout=aiohttp.ClientTimeout(total=2.0),
            ) as resp:
                resp.raise_for_status()
                return await resp.json()


def main() -> None:
    parser = argparse.ArgumentParser(description="AiNex OpenPI autonomous policy loop")
    parser.add_argument("--policy-url", type=str, default="http://localhost:8000/infer")
    parser.add_argument("--hz", type=float, default=10.0)
    parser.add_argument("--camera-device", type=int, default=0)
    parser.add_argument("--task", type=str, default="walk forward")
    parser.add_argument("--max-steps", type=int, default=1000)
    parser.add_argument("--no-perception", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    loop = OpenPIPolicyLoop(
        policy_url=args.policy_url,
        hz=args.hz,
        camera_device=args.camera_device,
        enable_perception=not args.no_perception,
    )

    if not args.no_perception:
        loop.start_perception()

    async def _run():
        async def _log_command(cmd):
            logger.info("Command: %s", json.dumps(cmd))

        result = await loop.run_loop(
            task=args.task,
            max_steps=args.max_steps,
            send_command_fn=_log_command,
        )
        print(f"Loop finished: {result}")

    try:
        asyncio.run(_run())
    finally:
        loop.stop_perception()


if __name__ == "__main__":
    main()
