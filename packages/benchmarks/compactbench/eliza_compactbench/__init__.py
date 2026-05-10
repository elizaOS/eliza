"""CompactBench harness for elizaOS TypeScript conversation compactors.

This package bridges Python-side ``compactbench.compactors.Compactor``
implementations to the TypeScript compactor strategies defined in
``packages/agent/src/runtime/conversation-compactor.ts``. A subprocess
spawns ``bun`` to run each strategy with stdin/stdout JSON IPC.

The judge model for question-answering is Cerebras ``gpt-oss-120b``,
served via Cerebras's OpenAI-compatible API.
"""

from eliza_compactbench.bridge import BridgeError, run_ts_compactor
from eliza_compactbench.compactors import (
    HierarchicalSummaryCompactor,
    HybridLedgerCompactor,
    NaiveSummaryCompactor,
    PromptStrippingPassthroughCompactor,
    StructuredStateCompactor,
)

__all__ = [
    "BridgeError",
    "HierarchicalSummaryCompactor",
    "HybridLedgerCompactor",
    "NaiveSummaryCompactor",
    "PromptStrippingPassthroughCompactor",
    "StructuredStateCompactor",
    "run_ts_compactor",
]
