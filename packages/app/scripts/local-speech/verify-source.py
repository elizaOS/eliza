#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,tarfile
b=Path(__file__).resolve().parent;source=b/'native-source';overrides={e['path']:e['after'] for e in json.loads((b/'sherpa-no-espeak-manifest.json').read_text())};count=0
with tarfile.open(b/'downloads/sherpa-source-v1.13.8.tar.gz') as archive:
 for entry in archive:
  if not entry.isfile():continue
  relative=entry.name.split('/',1)[1];path=source/entry.name
  expected=overrides.get(relative) or hashlib.sha256(archive.extractfile(entry).read()).hexdigest()
  assert path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest()==expected,relative
  count+=1
print(json.dumps({'verifiedRegularSourceFiles':count,'onlyChanges':'sherpa-no-espeak-manifest.json'}))
