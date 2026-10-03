import json
import subprocess
import sys

import pytest
from codex_adapter.accounts import CodexAccount
from codex_adapter.client import CodexClient


@pytest.mark.parametrize('mode', ['exit', 'malformed', 'failed', 'timeout', 'success'])
def test_real_process_attempt_preserves_full_evidence(tmp_path, mode):
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'auth.json').write_text('{"token":"fixture-secret-never-record"}')
    binary = tmp_path / 'codex'
    binary.write_text(f'#!{sys.executable}\n' + '''import json,sys,time
request=sys.stdin.read()
print('diagnostic-'+'x'*20000, file=sys.stderr, flush=True)
mode=''' + repr(mode) + '''
if mode == 'exit':
 print('complete failed process output',flush=True)
 sys.exit(7)
if mode == 'malformed':
 print('not-json',flush=True)
elif mode == 'failed':
 print(json.dumps({'type':'turn.failed','error':{'message':'controlled failure'}}),flush=True)
elif mode == 'timeout':
 print('partial timeout output',flush=True)
 time.sleep(30)
else:
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'done'}}))
 print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
''')
    binary.chmod(0o755)
    receipts = tmp_path / 'receipts'
    client = CodexClient(accounts=[CodexAccount('diagnostic', home)], codex_bin=str(binary), timeout_s=2 if mode == 'timeout' else 15, receipt_dir=receipts)
    if mode == 'success':
        assert client.send_message('task', {'observation': 'full-context'}).text == 'done'
    else:
        with pytest.raises((RuntimeError, ValueError, subprocess.TimeoutExpired)):
            client.send_message('task', {'observation': 'full-context'})
    paths = list(receipts.glob('*/attempt.json'))
    assert len(paths) == 1
    text = paths[0].read_text()
    receipt = json.loads(text)
    assert 'fixture-secret-never-record' not in text
    assert receipt['status'] == ('succeeded' if mode == 'success' else 'failed')
    assert receipt['context']['observation'] == 'full-context'
    assert receipt['stderr'] == 'diagnostic-' + 'x' * 20000 + '\n'
    assert receipt['stdout']
    assert receipt['account_id'] == 'diagnostic'
    assert receipt['finished_at'] >= receipt['started_at']
    if mode == 'exit':
        assert receipt['returncode'] == 7
    if mode == 'timeout':
        assert receipt['stdout'] == 'partial timeout output\n'
        assert receipt['error']['type'] == 'TimeoutExpired'


def test_unavailable_receipt_storage_prevents_process_execution(tmp_path, monkeypatch):
    receipts = tmp_path / 'receipts'
    receipts.write_text('not a directory')
    client = CodexClient(accounts=[], receipt_dir=receipts)
    def unexpected(*_args, **_kwargs):
        pytest.fail('Model process must not start without admitted receipt storage')
    monkeypatch.setattr(client, '_send_message', unexpected)
    with pytest.raises(OSError):
        client.send_message('task')


def test_final_receipt_write_failure_cannot_return_success(tmp_path, monkeypatch):
    from pathlib import Path
    from codex_adapter.client import MessageResponse
    receipts = tmp_path / 'receipts'
    client = CodexClient(accounts=[], receipt_dir=receipts)
    monkeypatch.setattr(client, '_send_message', lambda *_args: MessageResponse(text='done'))
    original = Path.replace
    writes = 0
    def replace(source, destination):
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError('controlled durable write failure')
        return original(source, destination)
    monkeypatch.setattr(Path, 'replace', replace)
    with pytest.raises(OSError, match='controlled durable write failure'):
        client.send_message('task')
    persisted = json.loads(next(receipts.glob('*/attempt.json')).read_text())
    assert persisted['status'] == 'started'
    assert client._attempt is None
