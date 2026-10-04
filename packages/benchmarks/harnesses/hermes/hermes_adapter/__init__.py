"""Public harness API; workload dependencies load only when requested."""

from importlib import import_module

_EXPORTS = {
    "HermesClient": ("hermes_adapter.client", "HermesClient"),
    "MessageResponse": ("hermes_adapter.client", "MessageResponse"),
    "HermesAgentManager": ("hermes_adapter.server_manager", "HermesAgentManager"),
    "build_bfcl_agent_fn": ("hermes_adapter.bfcl", "build_bfcl_agent_fn"),
    "build_clawbench_agent_fn": (
        "hermes_adapter.clawbench",
        "build_clawbench_agent_fn",
    ),
    "build_swe_bench_agent_fn": (
        "hermes_adapter.swe_bench",
        "build_swe_bench_agent_fn",
    ),
    "HermesTauAgent": ("hermes_adapter.tau_bench", "HermesTauAgent"),
    "build_tau_bench_agent_fn": (
        "hermes_adapter.tau_bench",
        "build_tau_bench_agent_fn",
    ),
    "HermesTerminalAgent": ("hermes_adapter.terminal_bench", "HermesTerminalAgent"),
    "build_terminal_bench_agent_fn": (
        "hermes_adapter.terminal_bench",
        "build_terminal_bench_agent_fn",
    ),
    "ENV_MODULES": ("hermes_adapter.env_runner", "ENV_MODULES"),
    "HermesEnvResult": ("hermes_adapter.env_runner", "HermesEnvResult"),
    "build_evaluate_command": ("hermes_adapter.env_runner", "build_evaluate_command"),
    "parse_hermes_env_result": ("hermes_adapter.env_runner", "parse_hermes_env_result"),
    "run_hermes_env": ("hermes_adapter.env_runner", "run_hermes_env"),
    "build_lifeops_bench_agent_fn": (
        "hermes_adapter.lifeops_bench",
        "build_lifeops_bench_agent_fn",
    ),
    "build_action_calling_agent_fn": (
        "hermes_adapter.action_calling",
        "build_action_calling_agent_fn",
    ),
    "build_agentbench_agent_fn": (
        "hermes_adapter.agentbench",
        "build_agentbench_agent_fn",
    ),
    "build_mind2web_agent_fn": ("hermes_adapter.mind2web", "build_mind2web_agent_fn"),
    "build_mint_agent_fn": ("hermes_adapter.mint", "build_mint_agent_fn"),
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
