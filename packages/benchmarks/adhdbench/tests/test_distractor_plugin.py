"""Tests for the distractor plugin."""

from elizaos_adhdbench.distractor_plugin import (
    ALL_DISTRACTOR_SPECS,
    DEFI_ACTIONS,
    SOCIAL_ACTIONS,
    PRODUCTIVITY_ACTIONS,
    FILE_ACTIONS,
    COMMUNICATION_ACTIONS,
    ANALYTICS_ACTIONS,
    MODERATION_ACTIONS,
    CONTENT_ACTIONS,
    GAMING_ACTIONS,
    get_distractor_actions,
    get_distractor_plugin_actions_for_scale,
)


def test_total_spec_count() -> None:
    """Verify we have exactly 50 distractor specs."""
    assert len(ALL_DISTRACTOR_SPECS) == 50


def test_domain_counts() -> None:
    """Verify each domain has the expected number of actions."""
    assert len(DEFI_ACTIONS) == 6
    assert len(SOCIAL_ACTIONS) == 6
    assert len(PRODUCTIVITY_ACTIONS) == 6
    assert len(FILE_ACTIONS) == 6
    assert len(COMMUNICATION_ACTIONS) == 6
    assert len(ANALYTICS_ACTIONS) == 6
    assert len(MODERATION_ACTIONS) == 6
    assert len(CONTENT_ACTIONS) == 6
    assert len(GAMING_ACTIONS) == 2


def test_unique_names() -> None:
    """All distractor action names must be unique."""
    names = [s.name for s in ALL_DISTRACTOR_SPECS]
    assert len(names) == len(set(names)), f"Duplicate names: {[n for n in names if names.count(n) > 1]}"


def test_no_collision_with_bootstrap() -> None:
    """Distractor names must not collide with bootstrap action names."""
    bootstrap_names = {
        "REPLY", "IGNORE", "NONE", "COMPACT_SESSION", "CHOOSE_OPTION",
        "SEND_MESSAGE", "ADD_CONTACT", "REMOVE_CONTACT", "UPDATE_CONTACT",
        "UPDATE_CONTACT_INFO", "SEARCH_CONTACTS", "FOLLOW_ROOM", "UNFOLLOW_ROOM",
        "MUTE_ROOM", "UNMUTE_ROOM", "RESET_SESSION", "STATUS", "UPDATE_SETTINGS",
        "UPDATE_ROLE", "GENERATE_IMAGE", "SCHEDULE_FOLLOW_UP",
    }
    distractor_names = {s.name for s in ALL_DISTRACTOR_SPECS}
    collision = bootstrap_names & distractor_names
    assert not collision, f"Name collision with bootstrap: {collision}"


def test_all_specs_have_description() -> None:
    """Every spec must have a non-empty description."""
    for spec in ALL_DISTRACTOR_SPECS:
        assert spec.description, f"{spec.name} has empty description"


def test_all_specs_have_similes() -> None:
    """Every spec must have at least one simile."""
    for spec in ALL_DISTRACTOR_SPECS:
        assert spec.similes, f"{spec.name} has no similes"


def test_all_specs_have_tags() -> None:
    """Every spec must have at least one tag."""
    for spec in ALL_DISTRACTOR_SPECS:
        assert spec.tags, f"{spec.name} has no tags"


def test_all_specs_have_domain() -> None:
    """Every spec must have a domain."""
    for spec in ALL_DISTRACTOR_SPECS:
        assert spec.domain, f"{spec.name} has no domain"


def test_get_distractor_actions_zero() -> None:
    """Requesting 0 distractors returns empty list."""
    assert get_distractor_actions(0) == []


def test_get_distractor_actions_partial() -> None:
    """Requesting fewer than 50 returns a subset."""
    actions = get_distractor_actions(10)
    assert len(actions) == 10


def test_get_distractor_actions_all() -> None:
    """Requesting 50 returns all base specs."""
    actions = get_distractor_actions(50)
    assert len(actions) == 50


def test_get_distractor_actions_overflow() -> None:
    """Requesting more than 50 generates variants."""
    actions = get_distractor_actions(100)
    assert len(actions) == 100
    names = [a.name for a in actions]
    assert len(names) == len(set(names)), "Variant names must be unique"


def test_get_distractor_actions_large_overflow() -> None:
    """Requesting 200+ generates enough unique variants."""
    actions = get_distractor_actions(200)
    assert len(actions) == 200
    names = [a.name for a in actions]
    assert len(names) == len(set(names)), "All 200 names must be unique"


def test_scale_function() -> None:
    """get_distractor_plugin_actions_for_scale computes correct count."""
    actions = get_distractor_plugin_actions_for_scale(
        scale_action_count=30, bootstrap_action_count=21
    )
    assert len(actions) == 9


def test_scale_function_no_need() -> None:
    """If bootstrap already exceeds target, returns empty."""
    actions = get_distractor_plugin_actions_for_scale(
        scale_action_count=10, bootstrap_action_count=21
    )
    assert len(actions) == 0
