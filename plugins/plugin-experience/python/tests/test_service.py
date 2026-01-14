from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceQuery, ExperienceType


def test_record_and_query_experiences() -> None:
    svc = ExperienceService(max_experiences=100)
    exp = svc.record_experience(
        agent_id="agent-1",
        context="debugging a failing build",
        action="run tests",
        result="fixed missing dependency",
        learning="Install dependencies before running Python scripts",
        domain="coding",
        tags=["extracted"],
        confidence=0.9,
        importance=0.8,
    )

    results = svc.query_experiences(ExperienceQuery(query="python dependencies install", limit=5))
    assert any(r.id == exp.id for r in results)

    filtered = svc.query_experiences(ExperienceQuery(type=ExperienceType.LEARNING, limit=10))
    assert any(r.id == exp.id for r in filtered)
