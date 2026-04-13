"""SOLANA_CONTEXT provider — injects discovery state into agent context.

Reads the ExplorationStrategy and SurfpoolEnv from runtime settings to
build a rich context string that tells the LLM what has been discovered
and what remains to be explored.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


async def _get_solana_context(
    runtime: IAgentRuntime, _message: Memory, _state: State
) -> ProviderResult:
    """
    Build the Solana exploration context.

    Includes: agent address, reward totals, discovered / remaining pairs,
    per-program undiscovered discriminators, and execution rules.
    """
    strategy = runtime.get_setting("EXPLORATION_STRATEGY")
    env = runtime.get_setting("SURFPOOL_ENV")

    if strategy is None and env is None:
        return ProviderResult(text="", values={}, data={})

    parts: list[str] = []
    parts.append("## Solana Exploration Context")
    parts.append("")

    # ── Agent info ──────────────────────────────────────────────────────
    agent_pubkey = ""
    if env is not None:
        agent_pubkey = str(env.agent_keypair.pubkey())
        parts.append(f"**Agent:** {agent_pubkey}")
        parts.append("**Connection:** http://localhost:8899")
        parts.append(f"**Total Reward:** {env.total_reward}")
        parts.append("")

    # ── Discovery state ────────────────────────────────────────────────
    total_reward = 0
    discovered_count = 0
    remaining_count = 0

    if strategy is not None:
        state = strategy.state
        total_reward = state.total_reward
        discovered_count = len(state.discovered)
        remaining_count = state.remaining_unique
        messages_left = strategy.max_messages - state.current_step

        parts.append(
            f"**Discovered:** {discovered_count} pairs | "
            f"**Remaining:** {remaining_count} | "
            f"**Messages left:** {messages_left}"
        )
        parts.append("")

        # ── Undiscovered programs ──────────────────────────────────────
        undiscovered = state.get_undiscovered_by_program()
        if undiscovered:
            parts.append("### Undiscovered Programs")
            parts.append("")

            # Lazy import to avoid module-level dependency on catalog
            from benchmarks.solana.instruction_catalog import PROGRAM_BY_ID

            for prog_id, discs in undiscovered.items():
                prog = PROGRAM_BY_ID.get(prog_id)
                name = prog.name if prog else prog_id[:16]
                parts.append(f"**{name}** (`{prog_id}`):")

                if prog:
                    ix_by_disc = {ix.discriminator: ix for ix in prog.instructions}
                    shown = discs[:20]  # cap to keep context manageable
                    for d in shown:
                        ix = ix_by_disc.get(d)
                        if ix:
                            parts.append(
                                f"  disc {d}: {ix.name} [{ix.difficulty.name}] {ix.notes}"
                            )
                        else:
                            parts.append(f"  disc {d}: unknown")
                    if len(discs) > 20:
                        parts.append(f"  ... and {len(discs) - 20} more")
                else:
                    parts.append(f"  discs: {discs}")

                parts.append("")

    # ── Execution rules ────────────────────────────────────────────────
    parts.append("### Rules")
    parts.append("")
    parts.append(
        "- Write `export async function executeSkill(blockhash: string): Promise<string>`"
    )
    parts.append("- Return base64 serialized transaction")
    parts.append("- Max ~60 instructions per transaction (Surfpool limit)")
    parts.append(
        "- Packages: @solana/web3.js, @solana/spl-token, @coral-xyz/anchor, bs58, bn.js"
    )
    parts.append("- Use `partialSign()` for new Keypairs")
    parts.append(
        "- Token-2022 extensions must be initialized BEFORE InitializeMint2"
    )
    parts.append("- Target EASY discriminators first, pack multiple per tx")

    text = "\n".join(parts)

    return ProviderResult(
        text=text,
        values={
            "totalReward": str(total_reward),
            "discoveredPairs": str(discovered_count),
            "remainingPairs": str(remaining_count),
            "agentPubkey": agent_pubkey,
        },
        data={
            "totalReward": total_reward,
            "discoveredPairs": discovered_count,
            "remainingPairs": remaining_count,
        },
    )


solana_context_provider = Provider(
    name="SOLANA_CONTEXT",
    description=(
        "Provides Solana exploration context including discovery state, "
        "agent info, and undiscovered program discriminators"
    ),
    position=50,  # Before RECENT_MESSAGES
    private=False,
    get=_get_solana_context,
)
