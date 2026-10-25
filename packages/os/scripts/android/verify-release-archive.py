#!/usr/bin/env python3
"""Inspect ZIP members without extracting or running any archive content."""
import hashlib
import json
import stat
import sys
import zipfile

release = json.load(sys.stdin)
expected = {release['archiveRoot'] + f['filename']: f for f in release['files']}
seen = set()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for member in archive.infolist():
        name = member.filename
        if (not name or name.startswith('/') or '\\' in name or ':' in name
                or any(p in ('.', '..') for p in name.split('/') if p)
                or name in seen or stat.S_IFMT(member.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError('unsafe or duplicate archive member: ' + name)
        seen.add(name)
        if member.is_dir():
            continue
        if name.endswith('.img') and name not in expected:
            raise ValueError('unbound image in archive: ' + name)
        if name not in expected:
            continue
        contract = expected[name]
        if member.file_size != contract['sizeBytes']:
            raise ValueError('archive member size mismatch: ' + name)
        digest = hashlib.sha256()
        with archive.open(member) as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != contract['sha256']:
            raise ValueError('archive member digest mismatch: ' + name)
missing = set(expected) - seen
if missing:
    raise ValueError('archive missing contracted files: ' + ', '.join(sorted(missing)))
