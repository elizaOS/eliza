from eliza_adapter.webshop import (
    _normalize_action_for_environment,
    _parse_action_from_response,
)


def test_parse_native_benchmark_action_command() -> None:
    chosen, action = _parse_action_from_response(
        "",
        ["BENCHMARK_ACTION"],
        {"BENCHMARK_ACTION": {"command": "search[water bottle]"}},
    )

    assert chosen == "WEBSHOP_ACTION"
    assert action == "search[water bottle]"


def test_normalize_common_aliases_to_available_click_actions() -> None:
    available = [
        "click[back to search]",
        "click[buy now]",
        "click[750ml]",
        "click[silver]",
    ]

    assert _normalize_action_for_environment("buy", available) == "click[buy now]"
    assert _normalize_action_for_environment("back", available) == "click[back to search]"
    assert (
        _normalize_action_for_environment("select_option[size, 750ml]", available)
        == "click[750ml]"
    )
    assert _normalize_action_for_environment("click[SILVER]", available) == "click[silver]"
