import pytest

from benchmarks.lib import CostAccumulator, compute_cost_usd, cost_from_usage


def test_unknown_is_not_free():
    assert compute_cost_usd("unpriced", 1, 2) is None
    assert compute_cost_usd(None, 1, 2) is None
    assert cost_from_usage("gpt-oss-120b", {}) is None
    costs = CostAccumulator()
    costs.add(1.0)
    costs.add(None)
    assert costs.total is None
    assert costs.metadata()["known_cost_usd"] == 1.0
    assert costs.metadata()["cost_complete"] is False


@pytest.mark.parametrize("count", [-1, float("nan"), float("inf"), True, 1.5])
def test_invalid_usage_rejected(count):
    with pytest.raises(ValueError, match="non-negative integers"):
        compute_cost_usd("gpt-oss-120b", count, 0)


def test_pricing_and_cache_counts():
    assert compute_cost_usd("cerebras/gpt-oss-120b", 1000000, 1000000) == pytest.approx(
        1.1
    )
    assert compute_cost_usd("other/gpt-oss-120b", 10, 10) is None
    assert (
        compute_cost_usd(
            "free",
            10,
            10,
            pricing={"free": {"input_per_million_usd": 0, "output_per_million_usd": 0}},
        )
        == 0
    )
    table = {
        "m": {
            "input_per_million_usd": 10,
            "output_per_million_usd": 20,
            "cached_input_per_million_usd": 1,
        }
    }
    assert compute_cost_usd(
        "m", 1000000, 100000, pricing=table, cached_prompt_tokens=500000
    ) == pytest.approx(7.5)
    with pytest.raises(ValueError, match="exceed"):
        compute_cost_usd("m", 1, 0, cached_prompt_tokens=2, pricing=table)
