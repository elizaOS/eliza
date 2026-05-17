#!/usr/bin/env python3
"""Minimal debug function: avoid nested layers and redundant error handling"""
from typing import Optional

from .logging_setup import setup_file_logging
from .main_debugger import MainDebugger, create_debugger


def run_debug(runtime_path: str, snapshot_id: str, component: str = "manager") -> None:
    debugger = create_debugger(
        runtime_path=runtime_path,
        snapshot_id=snapshot_id,
    )

    target_path = debugger.target_path
    setup_file_logging(str(debugger.target_path))

    if component == "manager":
        debugger.debug_manager()
    elif component == "worker":
        debugger.debug_worker()
    elif component == "evaluator":
        debugger.debug_evaluator()
    else:
        raise ValueError(f"Unknown component: {component}")


if __name__ == "__main__":
    import argparse
    import logging

    from .logging_setup import setup_debug_logging

    setup_debug_logging(logging.INFO)

    parser = argparse.ArgumentParser(description="Run snapshot/component debug easily from CLI")
    parser.add_argument(
        "--runtime",
        default="runtime/20250826_141730",
        help="Runtime directory path (default: runtime/20250826_141730)",
    )
    parser.add_argument(
        "--snapshot",
        default="snapshot_20250826_141736",
        help="Snapshot id/name (default: snapshot_20250826_141736)",
    )
    parser.add_argument(
        "--component",
        choices=["manager", "worker", "evaluator"],
        default="manager",
        help="Which component to debug (default: manager)",
    )

    # Hardcoded runtime path and snapshot name
    runtime_path = "runtime/20250826_141730"
    snapshot_id = "snapshot_20250826_141736"
    component = "manager"
    # args = parser.parse_args()
    run_debug(
        runtime_path=runtime_path, 
        snapshot_id=snapshot_id, 
        component=component
    )