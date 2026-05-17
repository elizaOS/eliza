"""CompactBench harness for elizaOS TypeScript conversation compactors.

This package bridges Python-side ``compactbench.compactors.Compactor``
implementations to the TypeScript compactor strategies defined in
``packages/agent/src/runtime/conversation-compactor.ts``. A subprocess
spawns ``bun`` to run each strategy with stdin/stdout JSON IPC.

The judge model for question-answering is Cerebras ``gpt-oss-120b``,
served via Cerebras's OpenAI-compatible API.
"""

from eliza_compactbench.bridge import BridgeError, run_ts_compactor

_COMPACTOR_EXPORTS = {
    "HierarchicalSummaryCompactor",
    "HybridLedgerCompactor",
    "NaiveSummaryCompactor",
    "PromptStrippingPassthroughCompactor",
    "StructuredStateCompactor",
}


def __getattr__(name: str):
    if name in _COMPACTOR_EXPORTS:
        from eliza_compactbench import compactors

        return getattr(compactors, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "BridgeError",
    "HierarchicalSummaryCompactor",
    "HybridLedgerCompactor",
    "NaiveSummaryCompactor",
    "PromptStrippingPassthroughCompactor",
    "StructuredStateCompactor",
    "run_ts_compactor",
]
