"""Public registry of legacy corpus adapters; families own their implementations."""

from __future__ import annotations
from .calibration import harmful_behaviors, harmless_alpaca
from .chat import chatml_text, gemma_text, noesis_text, open_paws_llama
from .common import Adapter
from .dialogue import dialogue_raw, light_multilight
from .distill import claude_distill
from .mcp import mcp_flow, mcp_messages, mcp_routing
from .native import eliza_native_passthrough
from .safety import scam_defense_corpus
from .tools import (
    aureth,
    bitagent,
    dolci_instruct,
    functions_53k,
    glaive_fc,
    glaive_fc_reasoning,
    hermes_3,
    hermes_fc,
    hermes_fc_thinking,
    hermes_omniforge,
    hermes_reasoning_tool_use,
    hermes_traces,
    hf_coding_tools_traces,
    mobile_actions,
    nemotron_coding_reasoning,
    nemotron_rl_tool_use,
    openclaw_operator,
    qwen36_trajectory,
    scambench_passthrough,
    sharegpt_tool_calls,
    toolhop,
)
from .trajectories import (
    agent_trove,
    nubilio_trajectories,
    reasoning_cot,
    terminal_corpus,
)
from .workflows import n8n_workflow

REGISTRY: dict[str, Adapter] = {
    # core / canonical
    "scambench_passthrough": scambench_passthrough,
    # tool calling
    "hermes_fc": hermes_fc,
    "hermes_fc_thinking": hermes_fc_thinking,
    "glaive_fc": glaive_fc,
    "glaive_fc_reasoning": glaive_fc_reasoning,
    "sharegpt_tool_calls": sharegpt_tool_calls,
    "functions_53k": functions_53k,
    "bitagent": bitagent,
    "toolhop": toolhop,
    # operator / mobile
    "openclaw_operator": openclaw_operator,
    "mobile_actions": mobile_actions,
    # agentic / hermes traces
    "nemotron_rl_tool_use": nemotron_rl_tool_use,
    "qwen36_trajectory": qwen36_trajectory,
    "hermes_reasoning_tool_use": hermes_reasoning_tool_use,
    "dolci_instruct": dolci_instruct,
    "hermes_traces": hermes_traces,
    "hermes_omniforge": hermes_omniforge,
    "hermes_3": hermes_3,
    "aureth": aureth,
    "nemotron_coding_reasoning": nemotron_coding_reasoning,
    "hf_coding_tools_traces": hf_coding_tools_traces,
    "chatml_text": chatml_text,
    "gemma_text": gemma_text,
    "open_paws_llama": open_paws_llama,
    "noesis_text": noesis_text,
    # MCP
    "mcp_messages": mcp_messages,
    "mcp_routing": mcp_routing,
    "mcp_flow": mcp_flow,
    # shell / terminal / agent trajectories
    "terminal_corpus": terminal_corpus,
    "agent_trove": agent_trove,
    # reasoning / CoT
    "reasoning_cot": reasoning_cot,
    # raw dialogue (consumed by synthesize_routing.py)
    "dialogue_raw": dialogue_raw,
    # multi-party fantasy roleplay (Facebook LIGHT MultiLIGHT)
    "light_multilight": light_multilight,
    # local eliza corpora
    "nubilio_trajectories": nubilio_trajectories,
    "scam_defense_corpus": scam_defense_corpus,
    # Nightly trajectory-export bridge (TS app-training plugin → Python
    # training pipeline). Rows are already eliza_native_v1 and have been
    # through the TS privacy filter; the passthrough adapter validates the
    # format and re-emits the canonical ElizaRecord intermediate.
    "eliza_native_passthrough": eliza_native_passthrough,
    # n8n workflow generation
    "n8n_workflow": n8n_workflow,
    # Claude distillation (Kassadin88/Claude-Distills) — preserves
    # <think>…</think>final-answer in expectedResponse verbatim.
    "claude_distill": claude_distill,
    # Abliteration calibration corpora (NOT in train mix; weight=0.0).
    # pack_dataset.py routes these to data/abliteration/{harmful,harmless}.jsonl.
    "harmful_behaviors": harmful_behaviors,
    "harmless_alpaca": harmless_alpaca,
}

__all__ = ["REGISTRY"]
