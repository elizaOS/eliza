"""Reviewed hosted-runner preflight; imported only by the sealed CI supervisor.

No import-time actions. This file must never be invoked for local cleanup.
"""
import json
import os
import pathlib
import platform
import pwd
import shutil
import stat
import sys


def prepare_host(plan, source, out, phase, *, metadata_only):
    policy = plan['hostEnvironment']
    assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    assert os.environ.get('RUNNER_ARCH') == 'X64'
    assert os.environ.get('GITHUB_REPOSITORY') == 'elizaOS/eliza'
    assert os.getuid() != 0 and pwd.getpwuid(os.getuid()).pw_name == 'runner'
    workspace = pathlib.Path(os.environ['GITHUB_WORKSPACE'])
    temporary = pathlib.Path(os.environ['RUNNER_TEMP'])
    assert workspace == pathlib.Path('/home/runner/work/eliza/eliza')
    assert temporary == pathlib.Path('/home/runner/work/_temp')
    assert workspace.resolve() == workspace and temporary.resolve() == temporary
    assert source == workspace / 'source' and out.parent == temporary
    assert pathlib.Path(__file__).resolve().parent == workspace / 'operator/.github/qualification/speech-retirement'
    assert os.environ.get('ImageOS') == 'ubuntu24'
    assert os.environ.get('ImageVersion') in policy['allowedImageVersions']
    release = platform.freedesktop_os_release()
    assert release['ID'] == 'ubuntu' and release['VERSION_ID'] == '24.04'
    assert (3, 12) <= sys.version_info[:2] < (3, 16)
    assert all(hasattr(os, name) for name in ('waitid', 'P_PID', 'WEXITED', 'WNOHANG', 'WNOWAIT'))
    assert pathlib.Path('/proc/self/stat').is_file()
    probe = "import os,subprocess,sys;p=subprocess.Popen([sys.executable,'-I','-B','-c','pass']);r=os.waitid(os.P_PID,p.pid,os.WEXITED|os.WNOWAIT);assert r.si_pid==p.pid and r.si_status==0;assert os.getpgid(p.pid)==os.getpgrp();assert p.wait()==0;print('WAITID_WNOWAIT_PGID_PASS')"
    result, _ = phase('host-waitid-capability', [sys.executable, '-I', '-B', '-c', probe], 10)
    assert result.strip() == 'WAITID_WNOWAIT_PGID_PASS'
    result, _ = phase('docker-platform', ['docker', 'version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], 10)
    assert result.strip() == 'linux/amd64'
    record = {
        'ImageVersion': os.environ['ImageVersion'], 'ImageOS': os.environ['ImageOS'],
        'python': sys.version, 'pythonExecutable': str(pathlib.Path(sys.executable).resolve()),
        'waitidWnowaitPgid': 'PASS', 'dockerPlatform': result.strip(),
        'workspace': str(workspace), 'runnerTemp': str(temporary),
        'freeBeforeCleanup': shutil.disk_usage(out).free,
        'cleanup': [], 'metadataOnly': metadata_only,
    }
    receipt = out / 'host-environment.json'
    def save():
        receipt.write_text(json.dumps(record, indent=2) + '\n')
    save()
    if metadata_only:
        return record
    # Fixed paths only: no environment expansion, glob, Docker prune or cache cleanup.
    assert policy['cleanupPaths'] == ['/usr/local/lib/android/sdk', '/usr/share/dotnet']
    for name in policy['cleanupPaths']:
        if shutil.disk_usage(out).free >= plan['resourceBounds']['minimumStartFreeBytes']:
            break
        target = pathlib.Path(name)
        entry = {'path': name, 'state': 'CHECKING'}
        record['cleanup'].append(entry)
        save()
        if not target.exists() and not target.is_symlink():
            entry['state'] = 'ABSENT'
            save()
            continue
        assert target.is_absolute() and target.resolve() == target
        for part in [target, *target.parents]:
            info = part.lstat()
            assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            # Official Android provisioning chmods the SDK leaf a+rwx. Its parent
            # must remain root-owned/non-writable, so the fixed leaf cannot be replaced.
            if part != target or name != '/usr/local/lib/android/sdk':
                assert not info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        # Reject targets on another filesystem and ANY nested mounts. rm adds its own guard.
        assert target.stat().st_dev == target.parent.stat().st_dev
        def unescape(value):
            for encoded, literal in [('\\040', ' '), ('\\011', '\t'), ('\\012', '\n'), ('\\134', '\\')]:
                value = value.replace(encoded, literal)
            return value
        mounts = pathlib.Path('/proc/self/mountinfo').read_text()
        for line in mounts.splitlines():
            point = pathlib.Path(unescape(line.split()[4]))
            assert not point.is_relative_to(target), 'Cleanup target contains a mount'
        entry['state'] = 'VALIDATED_PENDING_DELETE'
        entry['freeBefore'] = shutil.disk_usage(out).free
        save()
        # The privileged timeout, not the unprivileged supervisor, owns rm's deadline.
        # rm creates no child processes; foreground avoids a separate timeout process group.
        try:
            phase('cleanup-' + target.name, ['/usr/bin/sudo', '-n', '--', '/usr/bin/timeout',
                  '--foreground', '--signal=TERM', '--kill-after=5s', '50s', '/usr/bin/rm',
                  '-rf', '--one-file-system', '--preserve-root=all', '--', name], 60)
            assert not target.exists() and not target.is_symlink()
        except BaseException:
            entry['state'] = 'DELETION_OR_PRIVILEGED_CLOSURE_UNKNOWN_NO_AUTOMATIC_RETRY'
            record['privilegedCleanupClosureConfirmed'] = False
            save()
            raise
        # Exit0 from root timeout means its direct (non-spawning) rm child exited/reaped.
        entry['privilegedTimeoutAndRmExit'] = 0
        entry['targetAbsent'] = True
        record['privilegedCleanupClosureConfirmed'] = True
        entry['state'] = 'REMOVED'
        entry['freeAfter'] = shutil.disk_usage(out).free
        save()
    record['freeAfterCleanup'] = shutil.disk_usage(out).free
    record['entryFloorMet'] = record['freeAfterCleanup'] >= plan['resourceBounds']['minimumStartFreeBytes']
    save()
    assert record['entryFloorMet'], 'Unchanged entry disk floor unmet after bounded cleanup'
    return record
