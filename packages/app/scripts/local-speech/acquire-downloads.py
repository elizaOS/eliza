#!/usr/bin/env python3
"""Fetch only manifest-selected sources/models with size and hash checks; no SDK changes."""
from pathlib import Path
import hashlib,json,urllib.request,tarfile
b=Path(__file__).resolve().parent
for item in json.loads((b/'download-manifest.json').read_text()):
 if not item['acquire']:continue
 path=b/'downloads'/item['name'];path.parent.mkdir(exist_ok=True)
 if not path.exists():
  partial=path.with_suffix(path.suffix+'.partial');count=0
  with urllib.request.urlopen(item['browser_download_url']) as response,partial.open('wb') as out:
   while chunk:=response.read(1024*1024):
    count+=len(chunk)
    if count>item['size']:raise ValueError('Download exceeds reviewed size')
    out.write(chunk)
  assert count==item['size']
  assert hashlib.sha256(partial.read_bytes()).hexdigest()==item['observedSha256']
  partial.rename(path)
 assert path.stat().st_size==item['size']
 assert hashlib.sha256(path.read_bytes()).hexdigest()==item['observedSha256']
 if '.tar.' in path.name:
  dest=b/('native-source' if path.name.startswith('sherpa-source') else 'models');dest.mkdir(exist_ok=True)
  with tarfile.open(path) as archive:
   for entry in archive.getmembers():
    # Upstream contains an unrelated absolute Go symlink; never extract links.
    if not(entry.isfile() or entry.isdir()):continue
    target=(dest/entry.name).resolve()
    if not target.is_relative_to(dest.resolve()):raise ValueError('Archive path traversal')
    if entry.isdir():target.mkdir(parents=True,exist_ok=True)
    elif not target.exists():
     target.parent.mkdir(parents=True,exist_ok=True)
     with archive.extractfile(entry) as source,target.open('wb') as out:out.write(source.read())
print('Verified selected source/model archives; existing extracted files preserved')

for item in json.loads((b/'reference-manifest.json').read_text()):
 path=b/'reference'/item['path'];path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():
  with urllib.request.urlopen(item['url']) as response:data=response.read(item['bytes']+1)
  assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256']
  path.write_bytes(data)
 assert path.stat().st_size==item['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256']
print('Verified pinned reference files and ONNXRuntime headers')
