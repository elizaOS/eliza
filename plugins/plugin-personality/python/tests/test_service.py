"""Tests for the PersonalityService."""

from elizaos_plugin_personality import (
    CharacterModification,
    Confidence,
    EvolutionSuggestion,
    ModificationSource,
    ModificationType,
    PersonalityConfig,
    PersonalityService,
)


def _config(**overrides) -> PersonalityConfig:
    defaults = {"evolution_cooldown_ms": 1000, "modification_confidence_threshold": 0.7}
    defaults.update(overrides)
    return PersonalityConfig(**defaults)


def test_confidence_clamping():
    assert Confidence.of(1.5).value == 1.0
    assert Confidence.of(-0.5).value == 0.0
    assert Confidence.of(0.7).value == 0.7


def test_confidence_threshold():
    c = Confidence.of(0.8)
    assert c.meets_threshold(0.7)
    assert not c.meets_threshold(0.9)


def test_record_and_retrieve():
    svc = PersonalityService(_config())
    m = CharacterModification(
        agent_id="agent-1",
        modification_type=ModificationType.BIO,
        source=ModificationSource.EVOLUTION,
        field="bio",
        new_value=["curious", "helpful"],
        reason="learned from conversation",
        confidence=Confidence.of(0.85),
    )
    svc.record_modification(m)
    assert len(svc.get_modifications("agent-1")) == 1
    assert len(svc.get_modifications("agent-2")) == 0


def test_evolution_cooldown():
    svc = PersonalityService(_config())
    assert svc.can_evolve(0)
    svc.mark_evolution(1000)
    assert not svc.can_evolve(1500)
    assert svc.can_evolve(2000)


def test_evolution_disabled():
    svc = PersonalityService(_config(enable_auto_evolution=False))
    assert not svc.can_evolve(0)


def test_validate_xss():
    svc = PersonalityService(_config())
    m = CharacterModification(
        agent_id="a",
        modification_type=ModificationType.BIO,
        source=ModificationSource.USER,
        field="bio",
        new_value="<script>alert('xss')</script>",
        reason="test",
        confidence=Confidence.of(0.9),
    )
    result = svc.validate_modification(m)
    assert not result.is_safe
    assert any("XSS" in i for i in result.issues)


def test_validate_low_confidence():
    svc = PersonalityService(_config())
    m = CharacterModification(
        agent_id="a",
        modification_type=ModificationType.STYLE,
        source=ModificationSource.EVOLUTION,
        field="style",
        new_value="casual",
        reason="test",
        confidence=Confidence.of(0.3),
    )
    result = svc.validate_modification(m)
    assert not result.is_safe
    assert any("Confidence" in i for i in result.issues)


def test_validate_bio_limit():
    svc = PersonalityService(_config(max_bio_elements=3))
    m = CharacterModification(
        agent_id="a",
        modification_type=ModificationType.BIO,
        source=ModificationSource.USER,
        field="bio",
        new_value=["a", "b", "c", "d", "e"],
        reason="test",
        confidence=Confidence.of(0.9),
    )
    result = svc.validate_modification(m)
    assert not result.is_safe


def test_mark_applied():
    svc = PersonalityService(_config())
    m = CharacterModification(
        agent_id="a",
        modification_type=ModificationType.BIO,
        source=ModificationSource.USER,
        field="bio",
        new_value="new",
        reason="test",
        confidence=Confidence.of(0.9),
    )
    mod_id = m.id
    svc.record_modification(m)
    assert svc.mark_applied(mod_id)
    assert svc.get_modifications("a")[0].applied


def test_stats():
    svc = PersonalityService(_config())
    m1 = CharacterModification(
        agent_id="a",
        modification_type=ModificationType.BIO,
        source=ModificationSource.USER,
        field="bio",
        new_value="v1",
        reason="test",
        confidence=Confidence.of(0.9),
        applied=True,
    )
    svc.record_modification(m1)
    svc.record_modification(
        CharacterModification(
            agent_id="a",
            modification_type=ModificationType.STYLE,
            source=ModificationSource.EVOLUTION,
            field="style",
            new_value="v2",
            reason="test",
            confidence=Confidence.of(0.8),
        )
    )
    svc.record_suggestion(
        EvolutionSuggestion(
            agent_id="a",
            modification_type=ModificationType.TOPICS,
            field="topics",
            suggested_value=["rust"],
            reason="new interest",
            confidence=Confidence.of(0.75),
            conversation_context="discussed rust",
        )
    )
    stats = svc.stats("a")
    assert stats.total_modifications == 2
    assert stats.applied_modifications == 1
    assert stats.pending_suggestions == 1
