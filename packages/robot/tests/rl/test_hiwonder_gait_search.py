from __future__ import annotations

from scripts.search_hiwonder_open_loop_gaits import _candidate_specs


def test_hiwonder_gait_search_includes_seeded_sinusoidal_probes() -> None:
    names = {spec.name for spec in _candidate_specs()}

    assert "sinusoidal_seeded_0" in names
    assert "sinusoidal_seeded_1" in names
    assert "sinusoidal_seeded_2" in names
    assert "sinusoidal_seeded_3" in names
    assert "sinusoidal_seeded_4" in names
    assert "sinusoidal_seeded_5" in names
