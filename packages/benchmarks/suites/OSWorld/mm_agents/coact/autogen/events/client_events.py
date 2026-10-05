# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Callable, Literal, Optional, Union
from uuid import UUID

from pydantic import BaseModel

from .base_event import BaseEvent, wrap_event

__all__ = ["UsageSummaryEvent"]


class ModelUsageSummary(BaseModel):
    """Model usage summary."""

    model: str
    """Model name."""
    completion_tokens: int
    """Number of tokens used for completion."""
    cost: float
    """Cost of the completion."""
    prompt_tokens: int
    """Number of tokens used for prompt."""
    total_tokens: int
    """Total number of tokens used."""


class ActualUsageSummary(BaseModel):
    """Actual usage summary."""

    usages: Optional[list[ModelUsageSummary]] = None
    """List of model usage summaries."""
    total_cost: Optional[float] = None
    """Total cost."""


class TotalUsageSummary(BaseModel):
    """Total usage summary."""

    usages: Optional[list[ModelUsageSummary]] = None
    """List of model usage summaries."""
    total_cost: Optional[float] = None
    """Total cost."""


Mode = Literal["both", "total", "actual"]


def _change_usage_summary_format(
    actual_usage_summary: Optional[dict[str, Any]] = None, total_usage_summary: Optional[dict[str, Any]] = None
) -> dict[str, dict[str, Any]]:
    summary: dict[str, Any] = {}

    for usage_type, usage_summary in {"actual": actual_usage_summary, "total": total_usage_summary}.items():
        if usage_summary is None:
            summary[usage_type] = {"usages": None, "total_cost": None}
            continue

        usage_summary_altered_format: dict[str, list[dict[str, Any]]] = {"usages": []}
        for k, v in usage_summary.items():
            if isinstance(k, str) and isinstance(v, dict):
                current_usage = {key: value for key, value in v.items()}
                current_usage["model"] = k
                usage_summary_altered_format["usages"].append(current_usage)
            else:
                usage_summary_altered_format[k] = v
        summary[usage_type] = usage_summary_altered_format

    return summary


@wrap_event
class UsageSummaryEvent(BaseEvent):
    """Usage summary message."""

    actual: ActualUsageSummary
    """Actual usage summary."""
    total: TotalUsageSummary
    """Total usage summary."""
    mode: Mode
    """Mode to display the usage summary."""

    def __init__(
        self,
        *,
        uuid: Optional[UUID] = None,
        actual_usage_summary: Optional[dict[str, Any]] = None,
        total_usage_summary: Optional[dict[str, Any]] = None,
        mode: Mode = "both",
    ):
        # print(f"{actual_usage_summary=}")
        # print(f"{total_usage_summary=}")

        summary_dict = _change_usage_summary_format(actual_usage_summary, total_usage_summary)

        super().__init__(uuid=uuid, **summary_dict, mode=mode)

    def _print_usage(
        self,
        usage_summary: Union[ActualUsageSummary, TotalUsageSummary],
        usage_type: str = "total",
        f: Optional[Callable[..., Any]] = None,
    ) -> None:
        f = f or print
        word_from_type = "including" if usage_type == "total" else "excluding"
        if usage_summary.usages is None or len(usage_summary.usages) == 0:
            f("No actual cost incurred (all completions are using cache).", flush=True)
            return

        f(f"Usage summary {word_from_type} cached usage: ", flush=True)
        f(f"Total cost: {round(usage_summary.total_cost, 5)}", flush=True)  # type: ignore [arg-type]

        for usage in usage_summary.usages:
            f(
                f"* Model '{usage.model}': cost: {round(usage.cost, 5)}, prompt_tokens: {usage.prompt_tokens}, completion_tokens: {usage.completion_tokens}, total_tokens: {usage.total_tokens}",
                flush=True,
            )

    def print(self, f: Optional[Callable[..., Any]] = None) -> None:
        f = f or print

        if self.total.usages is None:
            f('No usage summary. Please call "create" first.', flush=True)
            return

        f("-" * 100, flush=True)
        if self.mode == "both":
            self._print_usage(self.actual, "actual", f)
            f()
            if self.total.model_dump_json() != self.actual.model_dump_json():
                self._print_usage(self.total, "total", f)
            else:
                f(
                    "All completions are non-cached: the total cost with cached completions is the same as actual cost.",
                    flush=True,
                )
        elif self.mode == "total":
            self._print_usage(self.total, "total", f)
        elif self.mode == "actual":
            self._print_usage(self.actual, "actual", f)
        else:
            raise ValueError(f'Invalid mode: {self.mode}, choose from "actual", "total", ["actual", "total"]')
        f("-" * 100, flush=True)


@wrap_event
class StreamEvent(BaseEvent):
    """Stream event."""

    content: str
    """Content of the event."""

    def __init__(self, *, uuid: Optional[UUID] = None, content: str) -> None:
        super().__init__(uuid=uuid, content=content)

    def print(self, f: Optional[Callable[..., Any]] = None) -> None:
        f = f or print

        # Set the terminal text color to green
        f("\033[32m", end="")

        f(self.content, end="", flush=True)

        # Reset the terminal text color
        f("\033[0m\n")
