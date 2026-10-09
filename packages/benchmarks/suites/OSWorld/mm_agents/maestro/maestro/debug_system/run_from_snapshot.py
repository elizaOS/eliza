#!/usr/bin/env python3
# python gui_agents/maestro/debug_system/run_from_snapshot.py
# python -m gui_agents.maestro.debug_system.run_from_snapshot
"""
Debug helper: restore MainController from a snapshot and optionally run it.
"""


import argparse
import logging
import time
from typing import Optional, List, Any

from ..data_models import CommandData
from ..new_global_state import NewGlobalState
from ..snapshot_restorer import (
    restore_maincontroller_from_globalstate,
)
from .logging_setup import setup_file_logging

logger = logging.getLogger(__name__)


def _extract_commands_sorted(controller) -> List[CommandData]:
    """Get all commands (CommandData) and sort them in ascending order by created_at."""
    gs: NewGlobalState = getattr(controller, "global_state")
    if gs is None or not hasattr(gs, "get_commands"):
        return []
    try:
        cmds: List[CommandData] = gs.get_commands() or []
    except Exception:
        return []
    try:
        return sorted(cmds, key=lambda c: getattr(c, "created_at", 0))
    except Exception:
        return cmds


def run_main_controller_from_snapshot(
    runtime_dir: str,
    snapshot_id: Optional[str] = None,
    target_dir: Optional[str] = None,
    os_word_task_id: Optional[str] = None,
):
    """
    Restore a MainController from an existing snapshot and optionally run it.

    Args:
        runtime_dir: Path to the runtime directory (e.g., "runtime/20250826_141730")
        snapshot_id: Snapshot ID (e.g., "snapshot_20250826_141736"); if None, interactive selection
        target_dir: Restore target directory; if None, it will be generated automatically
        auto_run: Whether to immediately execute the main loop

    Returns:
        The restored MainController if successful; otherwise None.
    """
    result = restore_maincontroller_from_globalstate(
        runtime_dir=runtime_dir,
        snapshot_id=snapshot_id,
        target_dir=target_dir,
        os_word_task_id=os_word_task_id
    )
    if result is None:
        logger.error("Failed to restore MainController from snapshot")
        return None

    controller, target_path, config_params = result

    # Write file logs to target_path
    setup_file_logging(target_path)

    logger.info(f"MainController restored from snapshot successfully. Logs at: {target_path}")

    # Execute commands in chronological order before running the main loop, with 5-second intervals
    try:
        commands = _extract_commands_sorted(controller)
        if commands:
            logger.info(f"Pre-executing {len(commands)} commands before main loop...")
        for idx, cmd in enumerate(commands, 1):
            try:
                logger.info(f"[PreExec {idx}/{len(commands)}] Executing command_id={getattr(cmd, 'command_id', 'N/A')}")
                executor = getattr(controller, "executor", None)
                if executor is not None and hasattr(executor, "execute_command"):
                    executor.execute_command(cmd)  # Execute only, do not touch global_state
                else:
                    logger.warning("Controller has no executor.execute_command; skipping pre-exec")
                    break
            except Exception as e:
                logger.warning(f"Pre-exec command failed: {e}")
            time.sleep(5)
    except Exception as e:
        logger.warning(f"Failed to pre-execute commands: {e}")

    controller.execute_main_loop()

    return controller


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run MainController from snapshot")
    parser.add_argument("runtime_dir", type=str, help="Path to runtime directory")
    parser.add_argument("--snapshot", "-s", type=str, default=None, help="Snapshot ID")
    parser.add_argument("--target", "-t", type=str, default=None, help="Restore target directory")
    parser.add_argument("--no-run", action="store_true", help="Do not auto-run main loop")
    return parser.parse_args()


if __name__ == "__main__":
    import logging
    from .logging_setup import setup_debug_logging, setup_file_logging

    # Simple console logging
    setup_debug_logging(logging.INFO)

    # Write to target_path log file (example with default test target directory)
    # If using CLI arguments, call setup_file_logging(args.target or target_path) after parsing

    # args = _parse_args()

    target_dir=None
    runtime_dir = "runtime/vmrun_20250831_003040/20250831_003117"
    snapshot_id = "snapshot_20250831_004442"
    # runtime_dir = "runtime/20250828_141244"
    # snapshot_id = "snapshot_20250828_141320"
    os_word_task_id = "535364ea-05bd-46ea-9937-9f55c68507e8"

    controller = run_main_controller_from_snapshot(
        runtime_dir=runtime_dir,
        snapshot_id=snapshot_id,
        target_dir=target_dir,
        os_word_task_id=os_word_task_id
    ) 
