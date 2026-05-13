"""Tests for GAIA orchestrated runner helpers."""

from elizaos_gaia.orchestrated import _parse_required_capabilities


def test_parse_required_capabilities_accepts_comma_joined_values() -> None:
    required = _parse_required_capabilities(
        [
            "research.web_search,research.web_browse",
            " research.docs_lookup ",
            "research.web_search",
        ]
    )

    assert required == [
        "research.web_search",
        "research.web_browse",
        "research.docs_lookup",
    ]
