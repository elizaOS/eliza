"""
Two-phase exploration strategy for the Solana benchmark.
Phase 1: deterministic templates. Phase 2: LLM with catalog context.
"""

import logging
from dataclasses import dataclass, field

from benchmarks.solana.instruction_catalog import ALL_PROGRAMS, PROGRAM_BY_ID, get_total_unique_pairs
from benchmarks.solana.skill_templates import DETERMINISTIC_TEMPLATES, get_template_for_step

logger = logging.getLogger(__name__)


@dataclass
class DiscoveryState:
    discovered: set[tuple[str, int]] = field(default_factory=set)
    current_step: int = 0
    total_reward: int = 0
    history: list[tuple[int, str, int, bool]] = field(default_factory=list)
    failed_templates: set[str] = field(default_factory=set)
    phase: str = "deterministic"

    @property
    def remaining_unique(self) -> int:
        return get_total_unique_pairs() - len(self.discovered)

    def record_discovery(self, program_id: str, discriminators: list[int]) -> int:
        """Returns count of genuinely new pairs."""
        before = len(self.discovered)
        self.discovered.update((program_id, d) for d in discriminators)
        return len(self.discovered) - before

    def record_step(self, step_name: str, reward: int, success: bool) -> None:
        self.history.append((self.current_step, step_name, reward, success))
        self.total_reward += reward
        self.current_step += 1
        if not success:
            self.failed_templates.add(step_name)

    def get_undiscovered_by_program(self) -> dict[str, list[int]]:
        result: dict[str, list[int]] = {}
        for prog in ALL_PROGRAMS:
            missing = [ix.discriminator for ix in prog.instructions
                       if (prog.program_id, ix.discriminator) not in self.discovered]
            if missing:
                result[prog.program_id] = missing
        return result


class ExplorationStrategy:

    def __init__(self, max_messages: int = 50):
        self.max_messages = max_messages
        self.state = DiscoveryState()
        self._det_idx = 0

    def get_next_action(self, agent_pubkey: str) -> dict:
        if self.state.current_step >= self.max_messages:
            return {"type": "done", "description": "All messages used"}

        while self._det_idx < len(DETERMINISTIC_TEMPLATES):
            name, code = get_template_for_step(self._det_idx, agent_pubkey)
            desc = DETERMINISTIC_TEMPLATES[self._det_idx][2]
            expected = DETERMINISTIC_TEMPLATES[self._det_idx][1]
            self._det_idx += 1
            if code and name not in self.state.failed_templates:
                return {"type": "deterministic", "template_name": name,
                        "code": code, "expected_reward": expected, "description": desc}

        self.state.phase = "llm_assisted"
        return {"type": "llm_assisted", "template_name": "llm_exploration",
                "prompt_context": self._build_llm_context(),
                "description": f"LLM exploration: {self.state.remaining_unique} remaining"}

    def record_result(self, template_name: str, reward: int, success: bool, info: dict | None = None) -> None:
        if info and "unique_instructions" in info:
            for prog_id, discs in info["unique_instructions"].items():
                self.state.record_discovery(prog_id, discs)
        self.state.record_step(template_name, reward, success)
        if success and reward > 0:
            logger.info("Step %d: %s  reward=%d  total=%d  discovered=%d",
                        self.state.current_step, template_name, reward,
                        self.state.total_reward, len(self.state.discovered))
        elif not success:
            logger.warning("Step %d: %s FAILED", self.state.current_step, template_name)

    def _build_llm_context(self) -> str:
        undiscovered = self.state.get_undiscovered_by_program()
        lines = [
            f"Discovered: {len(self.state.discovered)}  Reward: {self.state.total_reward}  "
            f"Messages left: {self.max_messages - self.state.current_step}",
            "",
        ]
        for prog_id, discs in undiscovered.items():
            prog = PROGRAM_BY_ID.get(prog_id)
            name = prog.name if prog else prog_id[:12]
            lines.append(f"\n{name} ({prog_id}):")
            if prog:
                ix_by_disc = {ix.discriminator: ix for ix in prog.instructions}
                for d in discs:
                    ix = ix_by_disc.get(d)
                    if ix:
                        lines.append(f"  disc {d}: {ix.name} [{ix.difficulty.name}] {ix.notes}")
            else:
                lines.append(f"  discs: {discs}")
        lines.append("\nTarget EASY first. Pack multiple per tx. Token-2022 extensions before InitializeMint2.")
        return "\n".join(lines)

    def get_summary(self) -> str:
        lines = [
            f"Messages: {self.state.current_step}/{self.max_messages}  "
            f"Reward: {self.state.total_reward}  "
            f"Discovered: {len(self.state.discovered)}  Phase: {self.state.phase}",
            "",
        ]
        for step_num, name, reward, success in self.state.history:
            lines.append(f"  {step_num:3d}. [{'OK' if success else 'FAIL'}] {name}: +{reward}")
        return "\n".join(lines)
