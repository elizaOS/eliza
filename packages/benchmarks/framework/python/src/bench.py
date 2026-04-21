#!/usr/bin/env python3
"""
Eliza Framework Benchmark — Python Runtime

Measures core agent framework performance with mock LLM handlers
and in-memory database. No real LLM calls, no disk I/O, no network.

Pass --real-llm to use a real OpenAI model provider instead of the mock.
This is useful for end-to-end testing but results will include network
latency and are NOT suitable for framework overhead measurement.

STATUS: UNVERIFIED — This benchmark has been written to match the Python
elizaos runtime API but has not yet been executed end-to-end. The following
API assumptions need verification when first run:
- elizaos.runtime.AgentRuntime constructor (agent_id, character, plugins, adapter)
- runtime.message_service.handle_message(runtime, message, callback) signature
- runtime._adapter access pattern for DB setup
- elizaos_plugin_inmemorydb.adapter.InMemoryDatabaseAdapter existence and API
- Plugin/Provider/ModelType class constructors from elizaos.types

If this benchmark fails on first run, check these assumptions against the
actual Python elizaos package API.
"""

from __future__ import annotations

import asyncio
import gc
import json
import os
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

# ─── Path setup ──────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
SHARED_DIR = SCRIPT_DIR.parent.parent / "shared"
RESULTS_DIR = SCRIPT_DIR.parent.parent / "results"

# ─── Imports from eliza packages ─────────────────────────────────────────────

from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character
from elizaos.types.memory import Memory
from elizaos.types.plugin import Plugin
from elizaos.types.primitives import Content

from .metrics import (
    MemoryMonitor,
    PipelineBreakdown,
    PipelineTimer,
    ScenarioResult,
    Timer,
    compute_latency_stats,
    compute_throughput_stats,
    format_duration,
    get_system_info,
    print_scenario_result,
)
from .mock_llm_plugin import mock_llm_plugin, create_dummy_providers


# ─── Real LLM support ────────────────────────────────────────────────────────

def resolve_llm_plugin(use_real_llm: bool) -> tuple[Plugin, bool]:
    """Resolve which LLM plugin to use based on the --real-llm flag.

    Returns a (plugin, is_real_llm) tuple.
    """
    if not use_real_llm:
        return mock_llm_plugin, False

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print(
            "ERROR: --real-llm requires OPENAI_API_KEY to be set in the environment.",
            file=sys.stderr,
        )
        sys.exit(1)

    from elizaos_plugin_openai import create_openai_elizaos_plugin

    plugin = create_openai_elizaos_plugin()
    return plugin, True


# ─── Types ───────────────────────────────────────────────────────────────────

class ScenarioMessage(TypedDict):
    content: str
    role: str


class ScenarioConfig(TypedDict, total=False):
    checkShouldRespond: bool
    multiStep: bool
    warmup: int
    iterations: int
    dummyProviders: int
    prePopulateHistory: int
    concurrent: bool
    dbOnly: bool
    dbOperation: str
    dbCount: int
    startupOnly: bool
    minimalBootstrap: bool


class Scenario(TypedDict):
    id: str
    name: str
    description: str
    messages: list[ScenarioMessage] | str
    config: ScenarioConfig


# ─── Fixed UUIDs ─────────────────────────────────────────────────────────────

AGENT_ID = "00000000-0000-0000-0000-000000000001"
USER_ENTITY_ID = "00000000-0000-0000-0000-000000000002"
ROOM_ID = "00000000-0000-0000-0000-000000000003"
WORLD_ID = "00000000-0000-0000-0000-000000000004"


# ─── Load shared configuration ───────────────────────────────────────────────

def load_scenarios() -> list[Scenario]:
    raw = (SHARED_DIR / "scenarios.json").read_text()
    return json.loads(raw)["scenarios"]


def load_character() -> dict[str, object]:
    raw = (SHARED_DIR / "character.json").read_text()
    return json.loads(raw)


def generate_messages(count: int) -> list[ScenarioMessage]:
    return [
        {"content": f"BenchmarkAgent, benchmark message number {i + 1}.", "role": "user"}
        for i in range(count)
    ]


def resolve_messages(messages: list[ScenarioMessage] | str) -> list[ScenarioMessage]:
    if isinstance(messages, str) and messages.startswith("_generate:"):
        count = int(messages.split(":")[1])
        return generate_messages(count)
    return messages  # type: ignore[return-value]


# ─── Runtime factory ─────────────────────────────────────────────────────────

async def create_benchmark_runtime(
    character: dict[str, object],
    config: ScenarioConfig,
    llm_plugin: Plugin = mock_llm_plugin,
) -> AgentRuntime:
    """Create an AgentRuntime with the given LLM plugin and in-memory DB."""
    # Attempt to import the in-memory DB adapter
    try:
        from elizaos_plugin_inmemorydb.plugin import create_database_adapter

        adapter = create_database_adapter(AGENT_ID)
        await adapter.init()
    except ImportError:
        adapter = None  # Runtime will handle missing adapter

    plugins: list[Plugin] = [llm_plugin]

    # Add dummy providers if requested
    dummy_count = config.get("dummyProviders", 0)
    if dummy_count and dummy_count > 0:
        from elizaos.types.plugin import Plugin
        dummy_providers = create_dummy_providers(dummy_count)
        plugins.append(Plugin(
            name="benchmark-dummy-providers",
            description=f"{dummy_count} dummy providers for scaling tests",
            providers=dummy_providers,
        ))

    existing_settings = character.get("settings", {}) if isinstance(character, dict) else {}
    extra_settings: dict[str, object] = {}
    if isinstance(existing_settings, dict):
        existing_extra = existing_settings.get("extra", {})
        if isinstance(existing_extra, dict):
            extra_settings.update(existing_extra)
    extra_settings["ALLOW_NO_DATABASE"] = "true"
    extra_settings["USE_MULTI_STEP"] = "true" if config.get("multiStep") else "false"
    extra_settings["VALIDATION_LEVEL"] = "trusted"

    char = {
        **character,
        "settings": {
            "extra": extra_settings,
        },
    }
    proto_char = dict(char)
    rename_map = {
        "messageExamples": "message_examples",
        "postExamples": "post_examples",
        "advancedPlanning": "advanced_planning",
        "advancedMemory": "advanced_memory",
    }
    for source_key, target_key in rename_map.items():
        if source_key in proto_char:
            proto_char[target_key] = proto_char.pop(source_key)

    runtime = AgentRuntime(
        agent_id=AGENT_ID,
        character=Character(**proto_char),
        plugins=plugins,
        adapter=adapter,
        disable_basic_capabilities=True,
        check_should_respond=False,
    )

    await runtime.initialize()

    # Set up world, room, entities if adapter exists
    db = runtime._adapter  # noqa: SLF001 — accessing private for benchmark setup
    if db is not None:
        try:
            await db.create_world({
                "id": WORLD_ID,
                "name": "BenchmarkWorld",
                "agentId": AGENT_ID,
                "messageServerId": "benchmark",
            })
            await db.create_rooms([{
                "id": ROOM_ID,
                "name": "BenchmarkRoom",
                "agentId": AGENT_ID,
                "source": "benchmark",
                "worldId": WORLD_ID,
                "type": "GROUP",
            }])
            await db.create_entities([{
                "id": USER_ENTITY_ID,
                "names": ["BenchmarkUser"],
                "agentId": AGENT_ID,
            }])
            await db.add_participants_room([USER_ENTITY_ID, AGENT_ID], ROOM_ID)
        except Exception as exc:
            print(f"    WARNING: DB setup failed ({type(exc).__name__}: {exc})", file=sys.stderr)
            print("    Benchmark will run without world/room/entity data — results may be incomplete.", file=sys.stderr)

    return runtime


# ─── Pre-populate history ────────────────────────────────────────────────────

async def pre_populate_history(runtime: AgentRuntime, count: int) -> None:
    if runtime._adapter is None:  # noqa: SLF001
        return
    base_time = int(time.time() * 1000) - count * 1000
    for i in range(count):
        memory = {
            "id": f"00000000-0000-0000-1000-{str(i).zfill(12)}",
            "agentId": AGENT_ID,
            "entityId": USER_ENTITY_ID,
            "roomId": ROOM_ID,
            "content": {
                "text": f"Historical message number {i + 1} for benchmark testing.",
                "source": "benchmark",
            },
            "createdAt": base_time + i * 1000,
        }
        try:
            await runtime.create_memory(memory, "messages")
        except Exception as exc:
            if i == 0:  # Only warn once to avoid spam
                print(f"    WARNING: pre_populate_history failed ({type(exc).__name__}: {exc})", file=sys.stderr)
            break


# ─── Message creation ────────────────────────────────────────────────────────

def create_message(text: str, index: int) -> Memory:
    return Memory(
        id=f"00000000-0000-0000-2000-{str(index).zfill(12)}",
        agent_id=AGENT_ID,
        entity_id=USER_ENTITY_ID,
        room_id=ROOM_ID,
        content=Content(text=text, source="benchmark"),
        created_at=int(time.time() * 1000),
    )


# ─── Instrumented message handling ───────────────────────────────────────────

async def process_message(
    runtime: AgentRuntime,
    message: Memory,
    pipeline_timer: PipelineTimer,
) -> None:
    """Process a single message through the runtime's message service."""
    message_service = runtime.message_service
    if message_service is None:
        raise RuntimeError("Message service not found on runtime")

    overall_start = time.perf_counter_ns()

    async def noop_callback(content: object) -> list[Memory]:
        return []

    await message_service.handle_message(
        runtime=runtime,
        message=message,
        callback=noop_callback,
    )

    overall_end = time.perf_counter_ns()
    pipeline_timer.record("model_call", (overall_end - overall_start) / 1_000_000)


# ─── Scenario runners ────────────────────────────────────────────────────────

async def run_startup_benchmark(
    character: dict[str, object],
    config: ScenarioConfig,
    llm_plugin: Plugin = mock_llm_plugin,
) -> ScenarioResult:
    timings: list[float] = []
    mem_monitor = MemoryMonitor()
    mem_monitor.start()

    iterations = config.get("iterations", 20)
    for _ in range(iterations):
        timer = Timer()
        timer.start()
        rt = await create_benchmark_runtime(character, config, llm_plugin)
        elapsed = timer.stop()
        timings.append(elapsed)

    resources = mem_monitor.stop()
    return ScenarioResult(
        iterations=iterations,
        warmup=0,
        latency=compute_latency_stats(timings),
        throughput=compute_throughput_stats(iterations, sum(timings)),
        pipeline=PipelineBreakdown(),
        resources=resources,
    )


async def run_db_benchmark(
    character: dict[str, object],
    config: ScenarioConfig,
    llm_plugin: Plugin = mock_llm_plugin,
) -> ScenarioResult:
    timings: list[float] = []
    mem_monitor = MemoryMonitor()
    count = config.get("dbCount", 10000)
    iterations = config.get("iterations", 5)
    operation = config.get("dbOperation", "write")

    for _ in range(iterations):
        runtime = await create_benchmark_runtime(character, config, llm_plugin)
        db = runtime._adapter  # noqa: SLF001
        if db is None:
            print("    WARNING: No database adapter available, skipping DB benchmark")
            return ScenarioResult(iterations=0, warmup=0)

        if operation == "write":
            mem_monitor.start()
            timer = Timer()
            timer.start()
            for j in range(count):
                memory = {
                    "id": f"00000000-0000-0000-3000-{str(j).zfill(12)}",
                    "agentId": AGENT_ID,
                    "entityId": USER_ENTITY_ID,
                    "roomId": ROOM_ID,
                    "content": {"text": f"Write benchmark message {j}", "source": "benchmark"},
                    "createdAt": int(time.time() * 1000),
                }
                await runtime.create_memory(memory, "messages")
            timings.append(timer.stop())
        else:
            await pre_populate_history(runtime, count)
            mem_monitor.start()
            timer = Timer()
            timer.start()
            for j in range(count):
                await db.get_memories(
                    table_name="messages",
                    room_id=ROOM_ID,
                    count=1,
                    offset=j,
                )
            timings.append(timer.stop())

    resources = mem_monitor.stop()
    total_time = sum(timings)

    return ScenarioResult(
        iterations=iterations,
        warmup=config.get("warmup", 0),
        latency=compute_latency_stats(timings),
        throughput=compute_throughput_stats(count * iterations, total_time),
        pipeline=PipelineBreakdown(
            memory_create_avg_ms=total_time / (count * iterations) if operation == "write" else 0.0,
            memory_get_avg_ms=total_time / (count * iterations) if operation == "read" else 0.0,
        ),
        resources=resources,
    )


async def run_message_benchmark(
    character: dict[str, object],
    messages: list[ScenarioMessage],
    config: ScenarioConfig,
    llm_plugin: Plugin = mock_llm_plugin,
) -> ScenarioResult:
    all_timings: list[float] = []
    pipeline_timer = PipelineTimer()
    mem_monitor = MemoryMonitor()

    warmup = config.get("warmup", 3)
    iterations = config.get("iterations", 10)
    pre_pop = config.get("prePopulateHistory", 0)
    concurrent = config.get("concurrent", False)

    # Warm-up
    for _ in range(warmup):
        runtime = await create_benchmark_runtime(character, config, llm_plugin)
        if pre_pop:
            await pre_populate_history(runtime, pre_pop)
        for m_idx, msg in enumerate(messages):
            mem = create_message(msg["content"], m_idx)
            await process_message(runtime, mem, PipelineTimer())

    gc.collect()
    mem_monitor.start()

    for i in range(iterations):
        runtime = await create_benchmark_runtime(character, config, llm_plugin)
        if pre_pop:
            await pre_populate_history(runtime, pre_pop)

        iter_timer = Timer()
        iter_timer.start()

        if concurrent and len(messages) > 1:
            # Run all messages concurrently using asyncio.gather
            tasks = []
            for m_idx, msg in enumerate(messages):
                mem = create_message(msg["content"], m_idx)
                tasks.append(process_message(runtime, mem, pipeline_timer))
            await asyncio.gather(*tasks)
        else:
            for m_idx, msg in enumerate(messages):
                mem = create_message(msg["content"], m_idx + i * len(messages))
                await process_message(runtime, mem, pipeline_timer)

        all_timings.append(iter_timer.stop())
        mem_monitor.poll()

    resources = mem_monitor.stop()
    total_time = sum(all_timings)
    total_messages = len(messages) * iterations

    pipeline = pipeline_timer.get_breakdown()
    # Compute framework time as wall-clock total minus model time
    pipeline.framework_time_total_ms = total_time - pipeline.model_time_total_ms

    return ScenarioResult(
        iterations=iterations,
        warmup=warmup,
        latency=compute_latency_stats(all_timings),
        throughput=compute_throughput_stats(total_messages, total_time),
        pipeline=pipeline,
        resources=resources,
    )


# ─── Main orchestrator ───────────────────────────────────────────────────────

async def main() -> None:
    args = sys.argv[1:]
    scenario_filter = None
    run_all = "--all" in args
    use_real_llm = "--real-llm" in args
    output_path = None

    for arg in args:
        if arg.startswith("--scenarios="):
            scenario_filter = arg.split("=")[1].split(",")
        elif arg.startswith("--output="):
            output_path = arg.split("=")[1]

    # Resolve which LLM plugin to use
    llm_plugin, is_real_llm = resolve_llm_plugin(use_real_llm)

    all_scenarios = load_scenarios()
    character = load_character()

    if scenario_filter:
        selected = [s for s in all_scenarios if s["id"] in scenario_filter]
    elif run_all:
        selected = all_scenarios
    else:
        default_ids = [
            "single-message", "conversation-10", "burst-100",
            "with-should-respond", "provider-scaling-10", "provider-scaling-50",
            "history-scaling-100", "history-scaling-1000",
            "concurrent-10", "db-write-throughput", "db-read-throughput",
            "startup-cold",
        ]
        selected = [s for s in all_scenarios if s["id"] in default_ids]

    print("╔══════════════════════════════════════════════════════════╗")
    print("║          Eliza Framework Benchmark — Python             ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print()

    if is_real_llm:
        print("NOTE: Using real LLM. Results will include network latency")
        print("      and are not suitable for framework overhead measurement.")
        print()

    sys_info = get_system_info()
    print(f"System: {sys_info.os} {sys_info.arch} | {sys_info.cpus} CPUs | {sys_info.memory_gb}GB RAM")
    print(f"Runtime: {sys_info.runtime_version}")
    print(f"LLM Mode: {'real (OpenAI)' if is_real_llm else 'mock (deterministic)'}")
    print(f"Scenarios: {len(selected)} selected")
    print()

    results: dict[str, object] = {
        "runtime": "python",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system": asdict(sys_info),
        "scenarios": {},
    }

    for scenario in selected:
        sys.stdout.write(f"Running: {scenario['name']}...")
        sys.stdout.flush()
        start = time.perf_counter_ns()

        cfg: ScenarioConfig = scenario["config"]

        if cfg.get("startupOnly"):
            result = await run_startup_benchmark(character, cfg, llm_plugin)
        elif cfg.get("dbOnly"):
            result = await run_db_benchmark(character, cfg, llm_plugin)
        else:
            msgs = resolve_messages(scenario["messages"])
            result = await run_message_benchmark(character, msgs, cfg, llm_plugin)

        elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
        print(f" done ({format_duration(elapsed_ms)})")
        print_scenario_result(scenario["id"], result, is_real_llm)

        results["scenarios"][scenario["id"]] = asdict(result)  # type: ignore[index]

    # Write results
    if output_path is None:
        output_path = str(RESULTS_DIR / f"python-{int(time.time() * 1000)}.json")
    Path(output_path).write_text(json.dumps(results, indent=2, default=str))
    print(f"\nResults written to: {output_path}")


def main_sync() -> None:
    """Synchronous entry point for script execution."""
    asyncio.run(main())


if __name__ == "__main__":
    main_sync()
