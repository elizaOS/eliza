from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

JSONPrimitive = str | int | float | bool | None
JSONValue = JSONPrimitive | list["JSONValue"] | dict[str, "JSONValue"]


def load_json_file(path: Path) -> JSONValue:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return cast(JSONValue, data)


def expect_dict(value: JSONValue, *, ctx: str) -> dict[str, JSONValue]:
    if not isinstance(value, dict):
        raise ValueError(f"{ctx}: expected object, got {type(value).__name__}")
    return value


def expect_list(value: JSONValue, *, ctx: str) -> list[JSONValue]:
    if not isinstance(value, list):
        raise ValueError(f"{ctx}: expected array, got {type(value).__name__}")
    return value


def expect_str(value: JSONValue, *, ctx: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{ctx}: expected string, got {type(value).__name__}")
    return value


def expect_int(value: JSONValue, *, ctx: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{ctx}: expected int, got {type(value).__name__}")
    return value


def expect_float(value: JSONValue, *, ctx: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{ctx}: expected number, got {type(value).__name__}")
    return float(value)


def expect_bool(value: JSONValue, *, ctx: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{ctx}: expected boolean, got {type(value).__name__}")
    return value


def get_required(d: Mapping[str, JSONValue], key: str, *, ctx: str) -> JSONValue:
    if key not in d:
        raise ValueError(f"{ctx}: missing required key '{key}'")
    return d[key]


def get_optional(d: Mapping[str, JSONValue], key: str) -> JSONValue | None:
    return d.get(key)


def find_latest_file(root: Path, *, glob_pattern: str) -> Path:
    matches = sorted(
        (p for p in root.glob(glob_pattern) if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        raise FileNotFoundError(f"No files matched {glob_pattern!r} under {str(root)!r}")
    return matches[0]


@dataclass(frozen=True)
class ModelSpec:
    provider: str | None = None
    model: str | None = None
    temperature: float | None = None


@dataclass(frozen=True)
class BenchmarkRequirements:
    env_vars: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()
    notes: str = ""


@dataclass(frozen=True)
class ScoreExtraction:
    score: float
    unit: str
    higher_is_better: bool
    metrics: dict[str, JSONValue]


CommandBuilder = Callable[
    [Path, ModelSpec, Mapping[str, JSONValue]],
    list[str],
]
ResultLocator = Callable[[Path], Path]
ScoreExtractor = Callable[[JSONValue], ScoreExtraction]


@dataclass(frozen=True)
class BenchmarkDefinition:
    id: str
    display_name: str
    description: str
    cwd_rel: str
    requirements: BenchmarkRequirements
    build_command: CommandBuilder
    locate_result: ResultLocator
    extract_score: ScoreExtractor


BenchmarkStatus = Literal["pass", "fail", "skip"]


@dataclass(frozen=True)
class BenchmarkRunResult:
    benchmark_id: str
    config: dict[str, JSONValue]
    status: BenchmarkStatus
    score: float | None
    unit: str | None
    higher_is_better: bool | None
    metrics: dict[str, JSONValue]
    artifacts: dict[str, str]
    duration_seconds: float | None
    error: str | None

