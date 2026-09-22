"""Observe this diagnostic job's descendants without arguments or host capacity data."""
import json
import os
from pathlib import Path
import sys
import time
from datetime import datetime, timezone

root = int(sys.argv[1])
directory = Path(os.environ['RUNNER_TEMP']) / 'transport-observation'
known = set()
previous = {}
with (directory / 'processes.jsonl').open('a') as output:
    def record(event, **fields):
        output.write(json.dumps(dict(event=event, at=datetime.now(timezone.utc).isoformat(), **fields)) + '\n')
        output.flush()

    record('observer-start', rootPid=root, observerPid=os.getpid())
    while True:
        current = {}
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                raw = (entry / 'stat').read_text()
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                # A process can exit between enumeration and reading its stat file.
                continue
            prefix, fields = raw.rsplit(')', 1)
            values = fields.split()
            pid = int(entry.name)
            current[pid] = dict(pid=pid, parentPid=int(values[1]), startTicks=values[19], command=prefix.split('(', 1)[1], state=values[0])
        selected = {pid for pid, value in current.items() if pid == root or (pid, value['startTicks']) in known}
        while True:
            added = {pid for pid, value in current.items() if value['parentPid'] in selected}
            if added <= selected:
                break
            selected |= added
        owned = {pid: current[pid] for pid in selected}
        for pid, value in owned.items():
            identity = (pid, value['startTicks'])
            known.add(identity)
            if pid not in previous or previous[pid]['startTicks'] != value['startTicks']:
                record('process-observed', **value)
        for pid, value in previous.items():
            if pid not in owned or owned[pid]['startTicks'] != value['startTicks']:
                record('process-no-longer-observed', **value)
        previous = owned
        if (directory / 'stop').exists():
            record('observer-stop', remaining=list(owned.values()))
            break
        time.sleep(1)
