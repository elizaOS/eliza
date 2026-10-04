"""Validate the pinned four-member Chromium archive before extracting one APK."""
import pathlib
import stat
import sys
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


archive, output = map(pathlib.Path, sys.argv[1:])
expected = {'chrome-android-desktop/apks/' + name + '.apk' for name in
            ['ChromePublic', 'ContentShell', 'SystemWebView', 'SystemWebViewShell']}
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    require(len(entries) == 4 and {entry.filename for entry in entries} == expected,
            'Unexpected Chromium archive members')
    for entry in entries:
        name = pathlib.PurePosixPath(entry.filename)
        require(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename,
                'Unsafe Chromium archive path')
        require(stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG),
                'Chromium archive member must be a regular file')
    require(not output.exists(), 'Output already exists')
    with output.open('xb') as target:
        target.write(source.read('chrome-android-desktop/apks/SystemWebView.apk'))
