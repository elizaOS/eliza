"""
Mock LLM Plugin for Framework Benchmarking — Python Runtime

Replaces all LLM model handlers with deterministic, zero-latency handlers
that return pre-computed valid XML responses. This isolates framework
overhead from LLM latency for accurate performance measurement.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types.model import ModelType
from elizaos.types.plugin import Plugin
from elizaos.types.components import ProviderResult

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

# ─── Mock response constants ────────────────────────────────────────────────

SHOULD_RESPOND_XML = """<response>
  <name>BenchmarkAgent</name>
  <reasoning>The message is directed at me. I should respond.</reasoning>
  <action>RESPOND</action>
</response>"""

MESSAGE_HANDLER_XML = """<response>
    <thought>Processing benchmark message. Will reply with a fixed response.</thought>
    <actions>REPLY</actions>
    <providers></providers>
    <text>This is a fixed benchmark response from the mock LLM plugin.</text>
    <simple>true</simple>
</response>"""

REPLY_ACTION_XML = """<response>
    <thought>Generating a reply for the benchmark.</thought>
    <text>Fixed reply from mock LLM plugin.</text>
</response>"""

MULTI_STEP_DECISION_XML = """<response>
  <thought>The task is straightforward, completing immediately.</thought>
  <action></action>
  <providers></providers>
  <isFinish>true</isFinish>
</response>"""

MULTI_STEP_SUMMARY_XML = """<response>
  <thought>Summarizing benchmark run.</thought>
  <text>Benchmark multi-step task completed successfully.</text>
</response>"""

REFLECTION_XML = """<response>
  <thought>Benchmark interaction processed normally.</thought>
  <facts></facts>
  <relationships></relationships>
</response>"""

ZERO_EMBEDDING: list[float] = [0.0] * 384


# ─── Handler implementations ────────────────────────────────────────────────

async def mock_text_large_handler(
    runtime: IAgentRuntime,
    params: dict[str, object],
) -> str:
    """Detect which template is being used and return appropriate response."""
    prompt = str(params.get("prompt", ""))

    if "Multi-Step Workflow" in prompt or "isFinish" in prompt:
        return MULTI_STEP_DECISION_XML
    if "Execution Trace" in prompt or "Summarize what the assistant" in prompt:
        return MULTI_STEP_SUMMARY_XML
    if "Generate Agent Reflection" in prompt or "Extract Facts" in prompt:
        return REFLECTION_XML
    if "Generate dialog for the character" in prompt and "decide what actions" not in prompt:
        return REPLY_ACTION_XML

    return MESSAGE_HANDLER_XML


async def mock_text_small_handler(
    runtime: IAgentRuntime,
    params: dict[str, object],
) -> str:
    """Handle TEXT_SMALL calls (shouldRespond, boolean, post generation)."""
    prompt = str(params.get("prompt", ""))

    if "should respond" in prompt or "RESPOND | IGNORE | STOP" in prompt:
        return SHOULD_RESPOND_XML
    if "Respond with only a YES or a NO" in prompt:
        return "YES"
    if "Generate dialog" in prompt:
        return MESSAGE_HANDLER_XML

    return SHOULD_RESPOND_XML


async def mock_embedding_handler(
    runtime: IAgentRuntime,
    params: dict[str, object],
) -> list[float]:
    """Return a fixed 384-dimension zero vector."""
    return ZERO_EMBEDDING


async def mock_object_handler(
    runtime: IAgentRuntime,
    params: dict[str, object],
) -> dict[str, str]:
    """Return a minimal object."""
    return {"result": "benchmark_object"}


async def mock_completion_handler(
    runtime: IAgentRuntime,
    params: dict[str, object],
) -> str:
    """Forward to TEXT_LARGE handler."""
    return await mock_text_large_handler(runtime, params)


# ─── Dummy providers for scaling tests ───────────────────────────────────────

def create_dummy_providers(count: int) -> list[object]:
    """Create N dummy providers that return minimal static data."""
    from elizaos.types.components import Provider

    providers: list[object] = []
    for i in range(count):
        async def _get(
            runtime: object, message: object, state: object = None, *, idx: int = i
        ) -> ProviderResult:
            return ProviderResult(
                text=f"Dummy provider {idx} context data.",
                values={f"dummy_{idx}": f"value_{idx}"},
                data={},
            )

        providers.append(Provider(
            name=f"BENCHMARK_DUMMY_{i}",
            description=f"Dummy provider #{i} for benchmark scaling tests",
            get=_get,
        ))
    return providers


# ─── Plugin definition ───────────────────────────────────────────────────────

mock_llm_plugin = Plugin(
    name="mock-llm-benchmark",
    description="Deterministic zero-latency mock LLM handlers for framework benchmarking",
    models={
        ModelType.TEXT_SMALL: mock_text_small_handler,
        ModelType.TEXT_LARGE: mock_text_large_handler,
        ModelType.TEXT_EMBEDDING: mock_embedding_handler,
        ModelType.TEXT_COMPLETION: mock_completion_handler,
        ModelType.OBJECT_SMALL: mock_object_handler,
        ModelType.OBJECT_LARGE: mock_object_handler,
    },
)
