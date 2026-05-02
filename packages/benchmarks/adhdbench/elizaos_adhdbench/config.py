"""Benchmark configuration."""

from __future__ import annotations

from dataclasses import dataclass

from elizaos_adhdbench.types import DEFAULT_SCALE_POINTS, ScalePoint


@dataclass
class ADHDBenchConfig:
    """Configuration for an ADHDBench run."""

    # ---- scale points ----
    scale_points: tuple[ScalePoint, ...] = DEFAULT_SCALE_POINTS

    # ---- configuration variants to test ----
    run_basic: bool = True
    """advancedMemory=False, advancedPlanning=False."""

    run_full: bool = True
    """advancedMemory=True, advancedPlanning=True."""

    # ---- model settings ----
    model_provider: str = "openai"
    model_name: str = "gpt-4o-mini"
    embedding_provider: str = "openai"

    # ---- scenario filtering ----
    levels: tuple[int, ...] = (0, 1, 2)
    tags: tuple[str, ...] = ()
    scenario_ids: tuple[str, ...] = ()

    # ---- output ----
    output_dir: str = "./adhdbench_results"
    generate_report: bool = True
    save_traces: bool = True


    # ---- character overrides ----
    character_name: str = "ADHDBench Agent"
    character_bio: str = "A helpful AI assistant being benchmarked for attention and context handling."
    character_system: str = (
        "You are a helpful assistant. Answer questions accurately and take "
        "actions when requested. Be concise."
    )

    # ---- conversation pre-fill ----
    prefill_topic_pool: tuple[str, ...] = (
        "Did you see the game last night? What a finish!",
        "I think we should switch to a new project management tool.",
        "The weather has been really unpredictable lately.",
        "Have you tried that new restaurant downtown?",
        "I need to update my resume. Any tips?",
        "What do you think about the latest AI developments?",
        "My laptop has been running slow. Should I get a new one?",
        "We should plan a team outing next month.",
        "I just finished reading a great book about leadership.",
        "The quarterly report is due next Friday.",
        "Can you explain how blockchain works?",
        "I am thinking about learning a new programming language.",
        "The client meeting went really well today.",
        "What is the best way to handle stress at work?",
        "I heard there is a new coffee shop on Main Street.",
        "We need to review the budget for Q3.",
        "Do you have any podcast recommendations?",
        "The server migration is scheduled for this weekend.",
        "I want to start exercising more regularly.",
        "Have you used any good productivity apps recently?",
    )

    def __post_init__(self) -> None:
        labels = [sp.label for sp in self.scale_points]
        if len(labels) != len(set(labels)):
            dupes = [l for l in labels if labels.count(l) > 1]
            raise ValueError(
                f"Duplicate scale point labels: {set(dupes)}. "
                f"Each ScalePoint must have unique (action_count, provider_count, conversation_prefill)."
            )

    @property
    def config_names(self) -> list[str]:
        """Active configuration variant names."""
        names: list[str] = []
        if self.run_basic:
            names.append("basic")
        if self.run_full:
            names.append("full")
        return names
