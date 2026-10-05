"""Public harness API; workload dependencies load only when requested."""

from importlib import import_module

_EXPORTS = {
    "run_code_agent_task": ("eliza_adapter.code_agent", "run_code_agent_task"),
    "ElizaClient": ("eliza_adapter.client", "ElizaClient"),
    "ElizaServerManager": ("eliza_adapter.server_manager", "ElizaServerManager"),
    "SWEBenchModelHandler": ("eliza_adapter.swe_bench", "SWEBenchModelHandler"),
    "make_eliza_swe_bench_model_handler": (
        "eliza_adapter.swe_bench",
        "make_eliza_swe_bench_model_handler",
    ),
    "ElizaBridgeTrustHandler": ("eliza_adapter.trust", "ElizaBridgeTrustHandler"),
    "build_lifeops_bench_agent_fn": (
        "eliza_adapter.lifeops_bench",
        "build_lifeops_bench_agent_fn",
    ),
    "fetch_world_state": ("eliza_adapter.lifeops_bench", "fetch_world_state"),
    "teardown_lifeops_session": (
        "eliza_adapter.lifeops_bench",
        "teardown_lifeops_session",
    ),
    "ElizaREALMAgent": ("eliza_adapter.realm", "ElizaREALMAgent"),
    "ElizaADHDBenchRunner": ("eliza_adapter.adhdbench", "ElizaADHDBenchRunner"),
    "ElizaBridgeExperienceRunner": (
        "eliza_adapter.experience",
        "ElizaBridgeExperienceRunner",
    ),
    "ElizaExperienceConfig": ("eliza_adapter.experience", "ElizaExperienceConfig"),
    "ElizaGauntletAgent": ("eliza_adapter.gauntlet", "Agent"),
    "ElizaMINTAgent": ("eliza_adapter.mint", "ElizaMINTAgent"),
}
__all__ = list(_EXPORTS)


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, symbol = _EXPORTS[name]
    value = getattr(import_module(module), symbol)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | set(__all__))
