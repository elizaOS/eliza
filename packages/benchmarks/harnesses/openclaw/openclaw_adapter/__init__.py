"""Public harness API; workload dependencies load only when requested."""

from importlib import import_module

_EXPORTS = {
    "MessageResponse": ("openclaw_adapter.client", "MessageResponse"),
    "OpenClawClient": ("openclaw_adapter.client", "OpenClawClient"),
    "OpenClawCLIManager": ("openclaw_adapter.server_manager", "OpenClawCLIManager"),
    "build_action_calling_agent_fn": (
        "openclaw_adapter.action_calling",
        "build_action_calling_agent_fn",
    ),
    "build_agentbench_agent_fn": (
        "openclaw_adapter.agentbench",
        "build_agentbench_agent_fn",
    ),
    "build_bfcl_agent_fn": ("openclaw_adapter.bfcl", "build_bfcl_agent_fn"),
    "build_clawbench_agent_fn": (
        "openclaw_adapter.clawbench",
        "build_clawbench_agent_fn",
    ),
    "build_lifeops_bench_agent_fn": (
        "openclaw_adapter.lifeops_bench",
        "build_lifeops_bench_agent_fn",
    ),
    "build_mind2web_agent_fn": ("openclaw_adapter.mind2web", "build_mind2web_agent_fn"),
    "build_mint_agent_fn": ("openclaw_adapter.mint", "build_mint_agent_fn"),
    "build_swe_bench_agent_fn": (
        "openclaw_adapter.swe_bench",
        "build_swe_bench_agent_fn",
    ),
    "OpenClawTerminalAgent": (
        "openclaw_adapter.terminal_bench",
        "OpenClawTerminalAgent",
    ),
    "build_terminal_bench_agent_fn": (
        "openclaw_adapter.terminal_bench",
        "build_terminal_bench_agent_fn",
    ),
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
