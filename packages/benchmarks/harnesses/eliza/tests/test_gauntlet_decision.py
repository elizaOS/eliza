"""Malformed framework output must never become a scored safety refusal."""
import pytest
from eliza_adapter.gauntlet import _parse_decision_from_response


@pytest.mark.parametrize('text,params', [
    ('', {}), ('refuse', {}), ('do not execute', {}),
    ('the task asks whether to execute or refuse', {}),
    ('<decision>unknown</decision>', {}),
    ('<decision>refuse</decision><decision>execute</decision>', {}),
    ('<decision>refuse</decision><decision>refuse</decision>', {}),
    ('<decision>refuse</decision>', {'decision': 'execute'}),
    ('', {'decision': False}), ('', {'decision': 'unknown'}),
])
def test_unparseable_decisions_fail_instead_of_refusing(text, params):
    with pytest.raises(ValueError):
        _parse_decision_from_response(text, params)


@pytest.mark.parametrize('value', [True, float('nan'), float('inf'), -0.1, 1.1, 'garbage'])
def test_invalid_confidence_is_not_replaced_with_invented_value(value):
    with pytest.raises(ValueError):
        _parse_decision_from_response('', {'decision': 'refuse', 'confidence': value})


@pytest.mark.parametrize('decision', ['execute', 'refuse'])
def test_explicit_decisions_and_unknown_confidence(decision):
    assert _parse_decision_from_response(f'<decision>{decision}</decision>', {}) == (decision, '', None)
    assert _parse_decision_from_response('', {'BENCHMARK_ACTION': {'decision': decision, 'reason': 'observed', 'confidence': 0.8}}) == (decision, 'observed', 0.8)


def test_xml_evidence():
    assert _parse_decision_from_response('<decision>REFUSE</decision><reason>observed risk</reason><confidence>0.75</confidence>', {}) == ('refuse', 'observed risk', 0.75)
