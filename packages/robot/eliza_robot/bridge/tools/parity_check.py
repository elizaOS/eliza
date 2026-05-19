"""Run the same trace against two bridge URIs and compare response parity."""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from websockets.asyncio.client import connect

from eliza_robot.bridge.types import JsonDict


@dataclass(frozen=True)
class ReplySummary:
    request_id: str
    command: str
    ok: bool
    message: str


def _load_trace(path: Path) -> list[JsonDict]:
    commands: list[JsonDict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        clean = line.strip()
        if clean == "" or clean.startswith("#"):
            continue
        parsed = json.loads(clean)
        if not isinstance(parsed, dict):
            raise ValueError("trace line must be a JSON object")
        commands.append(parsed)
    return commands


async def _run_trace(uri: str, commands: list[JsonDict]) -> list[ReplySummary]:
    summaries: list[ReplySummary] = []
    async with connect(uri) as ws:
        _ = await ws.recv()  # hello event
        for command in commands:
            request_id = str(command.get("request_id", "unknown"))
            await ws.send(json.dumps(command))
            while True:
                response_raw = await ws.recv()
                response = json.loads(response_raw)
                if not isinstance(response, dict):
                    raise ValueError("bridge response must be JSON object")
                if response.get("type") != "response":
                    continue
                if str(response.get("request_id", "")) != request_id:
                    continue

                ok = bool(response.get("ok", False))
                message = str(response.get("message", ""))
                command_name = str(command.get("command", "unknown"))
                summaries.append(
                    ReplySummary(
                        request_id=request_id,
                        command=command_name,
                        ok=ok,
                        message=message,
                    )
                )
                break
    return summaries


def _compare(a: list[ReplySummary], b: list[ReplySummary]) -> tuple[bool, list[str]]:
    issues: list[str] = []
    if len(a) != len(b):
        issues.append(f"length mismatch: left={len(a)} right={len(b)}")
        return False, issues
    for idx, (left, right) in enumerate(zip(a, b, strict=True)):
        if left.command != right.command:
            issues.append(
                f"[{idx}] command mismatch left={left.command} right={right.command}"
            )
        if left.ok != right.ok:
            issues.append(f"[{idx}] ok mismatch left={left.ok} right={right.ok}")
    return len(issues) == 0, issues


async def _main(left_uri: str, right_uri: str, trace_path: Path) -> int:
    commands = _load_trace(trace_path)
    left = await _run_trace(left_uri, commands)
    right = await _run_trace(right_uri, commands)
    ok, issues = _compare(left, right)

    print(f"left_uri={left_uri}")
    print(f"right_uri={right_uri}")
    if ok:
        print("parity_check=PASS")
        return 0

    print("parity_check=FAIL")
    for issue in issues:
        print(f"- {issue}")
    return 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare trace parity between two bridges")
    parser.add_argument("--left-uri", type=str, required=True, help="left bridge uri")
    parser.add_argument("--right-uri", type=str, required=True, help="right bridge uri")
    parser.add_argument("--trace", type=Path, required=True, help="trace JSONL path")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    exit_code = asyncio.run(
        _main(left_uri=args.left_uri, right_uri=args.right_uri, trace_path=args.trace)
    )
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()

