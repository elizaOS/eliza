from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_context_bench(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    _ = runtime
    _ = state
    meta = getattr(message, "metadata", None)
    bench_ctx = None
    if meta is not None:
        maybe = getattr(meta, "benchmarkContext", None)
        if isinstance(maybe, str) and maybe.strip():
            bench_ctx = maybe.strip()

    if not bench_ctx:
        return ProviderResult(
            text="",
            values={"benchmark_has_context": False},
            data={},
        )

    return ProviderResult(
        text=f"# Benchmark Context\n{bench_ctx}",
        values={"benchmark_has_context": True},
        data={"benchmarkContext": bench_ctx},
    )


context_bench_provider = Provider(
    name="CONTEXT_BENCH",
    description="Benchmark/task context injected by a benchmark harness",
    get=get_context_bench,
    dynamic=True,
)
