#!/usr/bin/env python3
"""Read-only ZIP admission for the privileged, preprocessed Sense import.

Signature, identity, permissions and speech hashes are separate staging checks.
This never rewrites a signed APK or substitutes for Soong's own checker.
"""
import argparse
import json
import struct
import zipfile


def verify(apk):
    with zipfile.ZipFile(apk) as archive, open(apk, 'rb') as raw:
        names = set()
        native = dex = 0
        for entry in archive.infolist():
            name = entry.filename
            if name in names or name.startswith('/') or '\\' in name or '..' in name.split('/'):
                raise ValueError('Duplicate or unsafe APK entry')
            names.add(name)
            if entry.flag_bits & 1:
                raise ValueError('Encrypted APK entry')
            is_native = name.startswith('lib/') and name.endswith('.so')
            is_dex = name.endswith('.dex')
            native += is_native
            dex += is_dex
            if (is_native or is_dex) and entry.compress_type != zipfile.ZIP_STORED:
                raise ValueError('Listener JNI and DEX must be stored before signing')
            raw.seek(entry.header_offset)
            header = raw.read(30)
            if len(header) != 30 or header[:4] != b'PK\x03\x04':
                raise ValueError('Invalid local ZIP header')
            method = struct.unpack_from('<H', header, 8)[0]
            name_size, extra_size = struct.unpack_from('<HH', header, 26)
            if method != entry.compress_type:
                raise ValueError('ZIP compression headers disagree')
            data_offset = entry.header_offset + 30 + name_size + extra_size
            alignment = 16384 if is_native else 4
            if entry.compress_type == zipfile.ZIP_STORED and not entry.is_dir() and data_offset % alignment:
                raise ValueError('Listener APK entry is not aligned: ' + name)
        if 'AndroidManifest.xml' not in names or 'classes.dex' not in names or not dex:
            raise ValueError('Listener APK must include manifest and DEX')
    return {'nativeLibrariesStored': True, 'dexEntriesStored': True,
            'nativeAlignmentBytes': 16384, 'nativeEntries': native,
            'dexEntries': dex, 'signatureVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk')
    print(json.dumps(verify(parser.parse_args().apk)))
