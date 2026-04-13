"""Perfect (Oracle) handler — returns ground truth for validation."""

from __future__ import annotations

from ..types import (
    Conversation,
    Extraction,
    GroundTruthWorld,
    IdentityExtraction,
    RelationshipExtraction,
    Resolution,
    ResolutionLink,
    TrustSignalExtraction,
)


class PerfectHandler:
    """Oracle handler that returns the exact ground truth.

    Used to validate the scoring harness: every metric should be 100 %.
    """

    name: str = "Perfect (Oracle)"

    async def setup(self) -> None:
        pass

    async def teardown(self) -> None:
        pass

    async def extract(
        self, conv: Conversation, world: GroundTruthWorld
    ) -> Extraction:
        return Extraction(
            conversation_id=conv.id,
            identities=[
                IdentityExtraction(
                    entity_id=i.entity_id,
                    platform=i.platform,
                    handle=i.handle,
                )
                for i in conv.expected.identities
            ],
            relationships=[
                RelationshipExtraction(
                    entity_a=r.entity_a,
                    entity_b=r.entity_b,
                    type=r.type,
                    sentiment=r.sentiment,
                )
                for r in conv.expected.relationships
            ],
            trust_signals=[
                TrustSignalExtraction(
                    entity_id=t.entity_id,
                    signal=t.signal,
                )
                for t in conv.expected.trust_signals
            ],
            traces=["Oracle: returned ground truth"],
            wall_time_ms=0.0,
        )

    async def resolve(
        self,
        extractions: list[Extraction],
        world: GroundTruthWorld,
    ) -> Resolution:
        return Resolution(
            links=[
                ResolutionLink(
                    entity_a=link.entity_a,
                    entity_b=link.entity_b,
                    confidence=1.0,
                    signals=[f"Truth: {link.reason}"],
                )
                for link in world.links
            ],
            traces=["Oracle: returned ground truth links"],
            wall_time_ms=0.0,
        )


perfect_handler = PerfectHandler()
