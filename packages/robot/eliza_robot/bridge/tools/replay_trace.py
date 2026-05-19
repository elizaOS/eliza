"""Replay a JSONL command trace against the websocket bridge."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from websockets.asyncio.client import connect

from eliza_robot.bridge.types import JsonDict


def _load_trace(path: Path) -> list[JsonDict]:
    commands: list[JsonDict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        clean = line.strip()
        if clean == "" or clean.startswith("#"):
            continue
        raw = json.loads(clean)
        if not isinstance(raw, dict):
            raise ValueError("trace lines must be JSON objects")
        commands.append(raw)
    return commands


async def _run(uri: str, trace_path: Path, delay_sec: float) -> None:
    commands = _load_trace(trace_path)
    async with connect(uri) as ws:
        hello = await ws.recv()
        print(f"hello: {hello}")
        for idx, command in enumerate(commands):
            request_id = str(command.get("request_id", "unknown"))
            await ws.send(json.dumps(command))
            while True:
                inbound_raw = await ws.recv()
                inbound = json.loads(inbound_raw)
                if isinstance(inbound, dict) and inbound.get("type") == "response":
                    if str(inbound.get("request_id", "")) == request_id:
                        print(
                            f"[{idx}] command={command.get('command')} response={inbound_raw}"
                        )
                        break
            await asyncio.sleep(delay_sec)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay websocket command trace")
    parser.add_argument(
        "--uri",
        type=str,
        default="ws://127.0.0.1:9100",
        help="bridge websocket URI",
    )
    parser.add_argument(
        "--trace",
        type=Path,
        required=True,
        help="path to JSONL command trace",
    )
    parser.add_argument(
        "--delay-sec",
        type=float,
        default=0.1,
        help="delay between trace commands",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    asyncio.run(_run(uri=args.uri, trace_path=args.trace, delay_sec=args.delay_sec))


if __name__ == "__main__":
    main()

