"""Exercises missing guardian firewall authority and explicitly recovers its owned reservation."""
import hashlib, importlib.util, json, os, pathlib, pwd, grp, shutil, signal, stat, subprocess, sys, tempfile, time
sys.dont_write_bytecode = True
source = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='eliza-capability-denial-', dir='/var/tmp'))
root.chmod(448)
files = ['stability-linux-sandbox.sh', 'stability-sandbox-owner.py', 'stability-sandbox-exec.py', 'stability-sandbox-identity.py', 'stability-native-attestation.py']
receipt = {'fixtureRoot': str(root), 'sourceHashes': {}, 'nativeQualified': False}
for name in files:
    data = (source / name).read_bytes()
    receipt['sourceHashes'][name] = hashlib.sha256(data).hexdigest()
    (root / name).write_bytes(data)
    (root / name).chmod(320 if name.endswith('.sh') else 256)
owner = root / 'stability-sandbox-owner.py'
text = owner.read_text()
anchor = '"--property=RuntimeDirectoryMode=0700",'
assert text.count(anchor) == 1
owner.write_text(text.replace(anchor, anchor + ' "--property=CapabilityBoundingSet=~CAP_NET_ADMIN",'))
receipt['fixtureOwnerSha256'] = hashlib.sha256(owner.read_bytes()).hexdigest()
spec = importlib.util.spec_from_file_location('owned_capability_fixture', owner)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.require_root()
launcher = root / 'stability-linux-sandbox.sh'
before = set(pathlib.Path('/run').glob('eliza-stability-owner-*'))
observed = {}
primary = None
try:
    with (root / 'stdout').open('w') as out, (root / 'stderr').open('w') as err:
        child = subprocess.Popen(['/bin/bash', str(launcher), 'setup'], stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
        setup_identity = module.process_identity(child.pid)
        receipt['setupIdentity'] = setup_identity
        deadline = time.monotonic() + 1215
        try:
            while child.poll() is None:
                for directory in set(pathlib.Path('/run').glob('eliza-stability-owner-*')) - before:
                    if str(directory) in observed:
                        continue
                    unit = directory.name + '.service'
                    command = module.command(['/usr/bin/systemctl', 'show', unit, '--property=Id,MainPID,CapabilityBoundingSet,ExecStart'], timeout=5)
                    values = dict((row.split('=', 1) for row in command.stdout.decode().splitlines() if '=' in row))
                    if values.get('MainPID', '0') != '0' and str(owner) in values.get('ExecStart', ''):
                        guardian_args = pathlib.Path('/proc', values['MainPID'], 'cmdline').read_bytes().split(b'\x00')
                        expected = [b'/usr/bin/python3', b'-I', b'-S', str(owner).encode()]
                        if guardian_args[:6] != expected + [b'guardian', str(directory).encode()]:
                            continue
                        upstream = json.loads(guardian_args[7])
                        assert module.process_identity(upstream['pid']) == upstream
                        ancestry = []
                        current = upstream['pid']
                        while current != setup_identity['pid']:
                            assert current > 1 and len(ancestry) < 16
                            identity = module.process_identity(current)
                            ancestry.append(identity)
                            process_fields = pathlib.Path('/proc', str(current), 'stat').read_text().rpartition(') ')[2].split()
                            assert module.process_identity(current) == identity
                            current = int(process_fields[1])
                        assert module.process_identity(current) == setup_identity
                        values['verifiedSetupAncestry'] = ancestry + [setup_identity]
                        module.private_directory(directory)
                        rows = module.Journal(directory).read()
                        starts = [row for row in rows if row['event'] == 'owner-started']
                        if not starts:
                            continue
                        assert starts[0]['data']['upstreamIdentity'] == upstream
                        controller = starts[0]['data']['controllerIdentity']
                        assert module.process_identity(controller['pid']) == controller
                        controller_args = pathlib.Path('/proc', str(controller['pid']), 'cmdline').read_bytes().split(b'\x00')
                        guardian_args = pathlib.Path('/proc', values['MainPID'], 'cmdline').read_bytes().split(b'\x00')
                        expected = [b'/usr/bin/python3', b'-I', b'-S', str(owner).encode()]
                        assert controller_args[:4] == expected and controller_args[4] == b'launcher-probe'
                        assert guardian_args[:6] == expected + [b'guardian', str(directory).encode()]
                        values['verifiedControllerIdentity'] = controller
                        values['verifiedProbeOutput'] = json.loads(guardian_args[9])[2]
                        observed[str(directory)] = values
                if time.monotonic() >= deadline:
                    raise TimeoutError('restricted setup deadline')
                time.sleep(0.25)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=15)
            group_members = []
            for proc in pathlib.Path('/proc').iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    fields = (proc / 'stat').read_text().rpartition(') ')[2].split()
                    if int(fields[2]) == child.pid:
                        group_members.append({'pid': int(proc.name), 'startTicks': int(fields[19]), 'session': int(fields[3]), 'state': fields[0]})
                except FileNotFoundError:
                    pass
            receipt['setupProcessGroup'] = {'pgid': child.pid, 'original': setup_identity, 'members': group_members}
            assert not group_members, 'owned setup process group remains after leader exit'
    receipt.update({'setupStatus': child.returncode, 'stdout': (root / 'stdout').read_text(), 'stderr': (root / 'stderr').read_text(), 'observedGuardianState': observed})
    assert child.returncode != 0 and 'ready' not in receipt['stdout']
    assert 'required kernel capability probe failed' in receipt['stderr']
    assert len(observed) == 1 and all(('cap_net_admin' not in value['CapabilityBoundingSet'].split() for value in observed.values()))
except BaseException as error:
    primary = error
    receipt['failure'] = type(error).__name__ + ': ' + str(error)
discovered = set(pathlib.Path('/run').glob('eliza-stability-owner-*')) - before
receipt['unverifiedDiscoveries'] = [str(d) for d in discovered if str(d) not in observed]
owners = {pathlib.Path(d) for d in observed}
receipt['owners'] = []
cleanup_errors = []
for directory in owners:
    try:
        journal = module.Journal(directory)
        rows = journal.read()
        state = {'directory': str(directory), 'beforeRecoveryJournal': rows}
        receipt['owners'].append(state)
        assert not any((row['event'] in ('native-key-intent', 'native-drained') for row in rows))
        names = next((row['data']['units'] for row in rows if row['event'] == 'owner-started'))
        for name in names.values():
            values = module.command(['/usr/bin/systemctl', 'show', name, '--property=ActiveState,ControlGroup,Job,MainPID,ControlPID'], timeout=10).stdout.decode()
            fields = dict((row.split('=', 1) for row in values.splitlines() if '=' in row))
            assert fields['ActiveState'] in ('inactive', 'failed') and (not fields['ControlGroup']) and (not fields['Job'])
            if name.endswith('.service'):
                assert fields['MainPID'] == '0' and fields['ControlPID'] == '0'
        probe = pathlib.Path(observed[str(directory)]['verifiedProbeOutput'])
        assert probe.parent == pathlib.Path('/var/tmp') and probe.name.startswith('eliza-stability-capability.')
        probe_info = probe.lstat()
        assert stat.S_ISDIR(probe_info.st_mode) and probe_info.st_uid == 65534
        state['retainedProbeIdentity'] = {'dev': probe_info.st_dev, 'ino': probe_info.st_ino, 'uid': probe_info.st_uid, 'path': str(probe)}
        state['restrictedGuardianCleanupVerified'] = bool(rows) and rows[-1]['event'] == 'cleanup-verified'
        if not state['restrictedGuardianCleanupVerified']:
            unit = 'eliza-capability-recovery-' + journal.nonce
            state['explicitFullAuthorityRecovery'] = {'unit': unit, 'attempted': True}
            recovery_error = None
            try:
                recovery = subprocess.run(['/usr/bin/systemd-run', '--quiet', '--wait', '--collect', '--unit=' + unit, '--service-type=exec', '--property=KillMode=control-group', '--property=RuntimeMaxSec=600s', '--property=TimeoutStopSec=10s', '/usr/bin/python3', '-I', '-S', str(owner), 'cleanup', str(directory), str(launcher)], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=635)
                state['explicitFullAuthorityRecovery'].update({'status': recovery.returncode, 'stdout': recovery.stdout, 'stderr': recovery.stderr})
                if recovery.returncode != 0:
                    raise RuntimeError('explicit recovery failed')
            except BaseException as error:
                recovery_error = error
                state['explicitFullAuthorityRecovery']['failure'] = type(error).__name__ + ': ' + str(error)
            finally:
                if recovery_error is not None:
                    try:
                        module.stop_owned_unit(unit + '.service')
                    except BaseException as error:
                        state['recoveryStopError'] = type(error).__name__ + ': ' + str(error)
                fields = dict((row.split('=', 1) for row in module.command(['/usr/bin/systemctl', 'show', unit + '.service', '--property=LoadState,ActiveState,ControlGroup,Job,MainPID,ControlPID'], timeout=10).stdout.decode().splitlines() if '=' in row))
                state['recoveryUnitState'] = fields
                assert fields['ActiveState'] == 'inactive' and (not fields['ControlGroup']) and (not fields['Job']) and (fields['MainPID'] == '0') and (fields['ControlPID'] == '0')
            if recovery_error is not None:
                raise recovery_error
        rows = journal.read()
        state['finalJournal'] = rows
        assert rows[-1]['event'] == 'cleanup-verified'
        identity = next((row['data'] for row in rows if row['event'] == 'identity-intent'))
        assert all((v.pw_uid != identity['uid'] and v.pw_gid != identity['gid'] for v in pwd.getpwall()))
        assert all((v.gr_gid != identity['gid'] for v in grp.getgrall()))
        live = []
        for path in pathlib.Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                if path.stat().st_uid == identity['uid']:
                    live.append(int(path.name))
            except FileNotFoundError:
                pass
        assert not live
        state['identityAbsent'] = True
        state['uidProcesses'] = live
        final_probe = probe.lstat()
        assert (final_probe.st_dev, final_probe.st_ino, final_probe.st_uid) == (probe_info.st_dev, probe_info.st_ino, 65534)
        retained_probe = root / 'verified-probe-cleanup'
        os.rename(probe, retained_probe)
        moved = retained_probe.lstat()
        state['probeCleanupQuarantine'] = str(retained_probe)
        assert (moved.st_dev, moved.st_ino, moved.st_uid) == (probe_info.st_dev, probe_info.st_ino, 65534)
        # The private root prevents replacement after the moved identity check.
        shutil.rmtree(retained_probe)
        try:
            probe.lstat()
        except FileNotFoundError:
            state['probeRemovedAfterVerifiedRecovery'] = True
        else:
            raise RuntimeError('owned probe cleanup did not remove exact directory')
    except BaseException as error:
        cleanup_errors.append(type(error).__name__ + ': ' + str(error))
receipt['cleanupErrors'] = cleanup_errors
receipt['passed'] = primary is None and len(owners) == 1 and (not cleanup_errors)
if receipt['passed']:
    shutil.rmtree(root)
receipt['fixtureRootAbsent'] = not root.exists()
print(json.dumps(receipt), flush=True)
raise SystemExit(0 if receipt['passed'] else 1)
