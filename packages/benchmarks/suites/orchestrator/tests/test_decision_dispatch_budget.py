from types import SimpleNamespace

import pytest

from benchmarks.orchestrator.adapters import _command_eliza_1
from benchmarks.orchestrator.types import RunRequest


@pytest.mark.parametrize('extra,n,limit', [({}, '1', None), ({'limit': 5}, '1', '5'), ({'limit': 5, 'n': 2}, '2', '5')])
def test_case_limit_does_not_change_repetition_budget(tmp_path, extra, n, limit):
    request = RunRequest(benchmarks=('eliza_1',), agent='hermes', provider='cerebras', model='fixture', extra_config=extra)
    command = _command_eliza_1(SimpleNamespace(request=request, output_root=tmp_path), None)
    assert command[command.index('--n') + 1] == n
    if limit is None:
        assert '--limit' not in command
    else:
        assert command[command.index('--limit') + 1] == limit


@pytest.mark.parametrize('agent,harness', [('eliza', 'hermes'), ('hermes', 'openclaw'), ('openclaw', 'eliza'), ('codex', 'hermes')])
def test_framework_override_cannot_mislabel_execution(tmp_path, agent, harness):
    request = RunRequest(benchmarks=('eliza_1',), agent=agent, provider='cerebras', model='fixture', extra_config={'harness': harness})
    with pytest.raises(ValueError, match='recorded agent identity'):
        _command_eliza_1(SimpleNamespace(request=request, output_root=tmp_path), None)
