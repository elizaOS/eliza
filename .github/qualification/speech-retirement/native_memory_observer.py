"""Read-only, same-process diagnostic observer. No compiler or SDK imports."""
import contextlib
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import time


class ProcessSnapshotRace(Exception):
    pass


class ObservationDeadline(TimeoutError):
    pass


@contextlib.contextmanager
def bounded_call(seconds):
    """One owned alarm; setup/restoration masked, including pending-signal drain."""
    alarm = {signal.SIGALRM}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, alarm)
    previous_handler = signal.getsignal(signal.SIGALRM)
    if signal.SIGALRM in previous_mask or signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0) or signal.SIGALRM in signal.sigpending():
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        raise RuntimeError('Inherited alarm/timer/mask prevents safe observation')
    def expired(signum, frame):
        raise ObservationDeadline('Native memory observation deadline')
    def restore():
        signal.pthread_sigmask(signal.SIG_BLOCK, alarm)
        signal.setitimer(signal.ITIMER_REAL, 0)
        pending = signal.SIGALRM in signal.sigpending()
        if pending:
            signal.sigwait(alarm)
        signal.signal(signal.SIGALRM, previous_handler)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        return pending
    try:
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, seconds)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        yield
    finally:
        import sys
        active_error = sys.exc_info()[0] is not None
        timed_out_during_restore = False
        try:
            pending = restore()
        except ObservationDeadline:
            # The owned timer is one-shot. Finish restoring before propagating it.
            timed_out_during_restore = True
            pending = restore()
        if not active_error and (pending or timed_out_during_restore):
            raise ObservationDeadline('Deadline reached during observation restoration')


class NativeMemoryObserver:
    # Reserve controller API evidence plus protected control input, receipt and effect witness.
    CAPS = {'MEMORY-CGROUP.jsonl': 65536,
            'MEMORY-PROCESS-SUMMARY.json': 90112,
            'MEMORY-OBSERVATION.json': 8192,
            'MEMORY-FINALIZATION.json': 8192}
    ROOT = pathlib.Path('/sys/fs/cgroup/system.slice')

    def __init__(self, item, verified_identity, source, output, absolute_deadline):
        self._fds = set()
        self.close_errors = []
        self.cid = item['cid']
        if not re.fullmatch('[a-f0-9]{64}', self.cid):
            raise RuntimeError('Unbound observer CID')
        name_match = re.fullmatch(r'normal-api-(\d+)-1-normal-api-entry', item['name'])
        if not name_match or verified_identity['Id'] != self.cid or verified_identity['Name'] != '/' + item['name']:
            raise RuntimeError('Observer container identity mismatch')
        labels = verified_identity['Labels']
        if labels.get('org.eliza.qualification-run') != name_match[1] or labels.get('org.eliza.qualification-kind') != 'speech-retirement':
            raise RuntimeError('Observer container label mismatch')
        r = item['resources']
        if (r['memoryBytes'], r['memorySwapBytes'], r['nanoCpus'], r['pidsLimit'], r['cgroupParent']) != (8589934592, 8589934592, 2000000000, 256, 'system.slice'):
            raise RuntimeError('Observer resource identity differs')
        if verified_identity['Resources'] != r or verified_identity['State']['Status'] != 'created' or verified_identity['State']['Running'] or verified_identity['State']['OOMKilled']:
            raise RuntimeError('Observer did not receive exact pre-start resource identity')
        self.container_binding = {'Id': self.cid, 'Name': verified_identity['Name'],
                                  'Labels': {key: labels[key] for key in ('org.eliza.qualification-run', 'org.eliza.qualification-kind')}, 'Resources': r}
        self.source, self.out = source, output
        self.deadline = absolute_deadline
        self.expected_cgroup = '/system.slice/docker-' + self.cid + '.scope'
        self.scope = self.ROOT / ('docker-' + self.cid + '.scope')
        self.fd = None
        self.scope_identity = None
        self.files = {}
        self.written = {n: 0 for n in self.CAPS}
        self.started = time.monotonic()
        self.next_poll = self.started
        self.next_timeline = self.started
        self.ticks = 0
        self.peak_current = None
        self.last_kernel = None
        self.vanished = False
        self.last_stage_size = -1
        self.api_start = None
        self.processes = {}
        self.native_bindings = {}
        self.races = 0
        self.finalized = False
        self.tick_bytes = self.tick_reads = 0
        self.total_input_bytes = self.total_read_calls = self.polls = 0
        self.max_tick_seconds = 0
        try:
            with bounded_call(2):
                self._initialize_native()
                for name in self.CAPS:
                    self.files[name] = self._acquire(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except BaseException:
            self._close()
            raise

    def _initialize_native(self):
        owners_fd = self._acquire(self.out / 'COMPILER-OWNERS.json', os.O_RDONLY | os.O_NOFOLLOW)
        try:
            owner_stat = os.fstat(owners_fd)
            if not stat.S_ISREG(owner_stat.st_mode) or owner_stat.st_size > 32768:
                raise RuntimeError('Owner metadata input bound')
            owners_raw = os.read(owners_fd, 32769)
            if len(owners_raw) > 32768:
                raise RuntimeError('Owner metadata grew beyond input bound')
            owners = json.loads(owners_raw)
        finally:
            self._release(owners_fd)
        self.native = owners['nativeApiTsc']
        expected = self.native['file']
        if not expected.startswith('/workspace/node_modules/'):
            raise RuntimeError('Native compiler outside subject dependencies')
        host = (self.source / expected.removeprefix('/workspace/')).resolve(strict=True)
        if not host.is_relative_to((self.source / 'node_modules').resolve()):
            raise RuntimeError('Borrowed native executable')
        native_fd = self._acquire(host, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(native_fd)
            if not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o111 or not 0 < before.st_size <= 67108864:
                raise RuntimeError('Native executable size/type/mode')
            digest = hashlib.sha256()
            count = 0
            while chunk := os.read(native_fd, 65536):
                count += len(chunk)
                if count > before.st_size:
                    raise RuntimeError('Native executable grew while hashing')
                digest.update(chunk)
            after = os.fstat(native_fd)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or digest.hexdigest() != self.native['sha256']:
                raise RuntimeError('Native executable content changed')
            self.native_identity = (after.st_dev, after.st_ino)
            self.native_content_stamp = (after.st_size, after.st_mtime_ns)
        finally:
            self._release(native_fd)

    def _acquire(self, *args, **kwargs):
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
        fd = None
        try:
            fd = os.open(*args, **kwargs)
            try:
                self._fds.add(fd)
            except BaseException:
                os.close(fd)
                raise
            return fd
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)

    def _release(self, fd):
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
        try:
            if fd not in self._fds:
                raise RuntimeError('Attempt to release an unregistered observer descriptor')
            try:
                os.close(fd)
            except OSError as error:
                self.close_errors.append(error.errno)
                raise
            finally:
                # Linux releases a valid descriptor even when close reports EINTR/EIO.
                # Never retry a close and risk a recycled descriptor number.
                self._fds.discard(fd)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)

    def _write(self, name, data):
        if os.fstat(self.files[name]).st_size != self.written[name]:
            raise RuntimeError('Memory diagnostic file changed outside observer')
        if self.written[name] + len(data) > self.CAPS[name]:
            raise RuntimeError('Memory diagnostic file cap: ' + name)
        view = memoryview(data)
        while view:
            n = os.write(self.files[name], view)
            if n <= 0:
                raise RuntimeError('Short memory diagnostic write')
            self.written[name] += n
            view = view[n:]
        if os.fstat(self.files[name]).st_size != self.written[name]:
            raise RuntimeError('Memory diagnostic size changed')

    def _read(self, directory, name, limit=8192):
        self.tick_reads += 1
        self.total_read_calls += 1
        if self.tick_reads > 2048 or self.total_read_calls > 262144 or time.monotonic() > self.deadline:
            raise RuntimeError('Observer I/O or whole deadline')
        fd = self._acquire(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            data = os.read(fd, limit + 1)
            self.tick_bytes += len(data)
            self.total_input_bytes += len(data)
            if len(data) > limit or self.tick_bytes > 2097152 or self.total_input_bytes > 67108864:
                raise RuntimeError('Observer bounded input exceeded')
            return data
        finally:
            self._release(fd)

    @staticmethod
    def _proc_stat(data):
        values = data.decode('ascii').rsplit(')', 1)[1].split()
        return {'state': values[0], 'parentPid': int(values[1]), 'birth': values[19]}

    def _stage(self):
        path = self.out / 'API-STAGES.jsonl'
        if not path.exists():
            return
        fd = self._acquire(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 49152:
                raise RuntimeError('Stage input exceeds observation contract')
            if info.st_size == self.last_stage_size:
                return
            self.tick_reads += 1
            self.total_read_calls += 1
            if self.tick_reads > 2048 or self.total_read_calls > 262144:
                raise RuntimeError('Stage observation read-call bound')
            data = os.read(fd, 49153)
            self.tick_bytes += len(data)
            self.total_input_bytes += len(data)
            if self.tick_bytes > 2097152 or self.total_input_bytes > 67108864:
                raise RuntimeError('Stage observation aggregate input bound')
            if len(data) > 49152:
                raise RuntimeError('Stage input grew beyond observation bound')
            self.last_stage_size = len(data)
            # A currently appended last line is not repaired or accepted.
            complete = data if data.endswith(b'\n') else data.rsplit(b'\n', 1)[0] if b'\n' in data else b''
            rows = [json.loads(line) for line in complete.splitlines() if line]
            starts = [x for x in rows if x['stage'] == 'api-normal-tsc' and x['event'] == 'start']
            if len(starts) > 1:
                raise RuntimeError('Multiple API compiler starts')
            if starts:
                row = starts[0]
                if row['argv'] != ['--noEmit'] or row['executableSHA256'] != '2219f428a7e55aaf1f7ad85b9b0f0cf5078aeb76ccc9a7c6036c92d48f492ffd' or not str(row['procBirthTicks']).isdigit():
                    raise RuntimeError('Unbound API compiler launch')
                self.api_start = row
        finally:
            self._release(fd)

    def _process(self, pid):
        fd = self._acquire('/proc/' + str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            first = self._proc_stat(self._read(fd, 'stat'))
            membership = self._read(fd, 'cgroup').decode('ascii').splitlines()
            if membership != ['0::' + self.expected_cgroup]:
                raise RuntimeError('PID no longer belongs to exact owned CID')
            status = self._read(fd, 'status', 16384).decode('ascii')
            fields = {}
            for line in status.splitlines():
                key, _, value = line.partition(':')
                if key in ('NSpid', 'VmRSS', 'VmHWM'):
                    fields[key] = value.strip()
            namespace_pids = [int(x) for x in fields['NSpid'].split()]
            metrics = {}
            for key in ('VmRSS', 'VmHWM'):
                if key in fields:
                    number, unit = fields[key].split()
                    if unit != 'kB':
                        raise RuntimeError('Unknown RSS units')
                    metrics[key] = int(number) * 1024
            exe_fd = self._acquire('exe', os.O_RDONLY, dir_fd=fd)
            try:
                image = os.fstat(exe_fd)
                is_native = (image.st_dev, image.st_ino) == self.native_identity
                if is_native and (image.st_size, image.st_mtime_ns) != self.native_content_stamp:
                    raise RuntimeError('Native executable changed after fresh binding')
            finally:
                self._release(exe_fd)
            self.tick_reads += 1
            self.total_read_calls += 1
            if self.tick_reads > 2048 or self.total_read_calls > 262144:
                raise RuntimeError('Exe metadata read-call bound')
            exe = os.readlink('exe', dir_fd=fd)
            exe_bytes = len(os.fsencode(exe))
            self.tick_bytes += exe_bytes
            self.total_input_bytes += exe_bytes
            if exe_bytes > 1024 or self.tick_bytes > 2097152 or self.total_input_bytes > 67108864:
                raise RuntimeError('Exe diagnostic path bound')
            argv_bytes = self._read(fd, 'cmdline', 4096)
            argv = argv_bytes.rstrip(b'\0').split(b'\0') if argv_bytes else []
            last = self._proc_stat(self._read(fd, 'stat'))
            if first['birth'] != last['birth']:
                raise ProcessSnapshotRace('PID birth changed')
            if self._read(fd, 'cgroup').decode('ascii').splitlines() != ['0::' + self.expected_cgroup]:
                raise RuntimeError('PID moved outside exact owned cgroup')
            image_fd = self._acquire('exe', os.O_RDONLY, dir_fd=fd)
            try:
                last_image = os.fstat(image_fd)
            finally:
                self._release(image_fd)
            if (image.st_dev, image.st_ino) != (last_image.st_dev, last_image.st_ino):
                raise ProcessSnapshotRace('Exec image changed while sampling')
            return {'hostPid': pid, **last, 'namespacePids': namespace_pids, **metrics,
                    'parentChangedDuringSample': first['parentPid'] != last['parentPid'],
                    'exe': exe, 'exeDevice': image.st_dev, 'exeInode': image.st_ino,
                    'isExpectedNative': is_native, 'argvSHA256': hashlib.sha256(argv_bytes).hexdigest(),
                    'argc': len(argv), 'nativeCanonicalArgv': is_native and argv == [self.native['file'].encode(), b'--noEmit']}
        finally:
            self._release(fd)

    def poll(self):
        now = time.monotonic()
        if now < self.next_poll or self.finalized:
            return
        self.next_poll = now + 1
        self.polls += 1
        if self.polls > 901:
            raise RuntimeError('Whole observation poll bound')
        self.tick_bytes = self.tick_reads = 0
        began = time.monotonic()
        try:
            with bounded_call(min(.25, max(.001, self.deadline - now))):
                if self.fd is None:
                    try:
                        self.fd = self._acquire(self.scope, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    except FileNotFoundError:
                        if now - self.started > 5:
                            raise RuntimeError('Owned cgroup did not appear')
                        return
                    info = os.fstat(self.fd)
                    self.scope_identity = (info.st_dev, info.st_ino)
                    self._check_limits()
                try:
                    info = os.stat(self.scope, follow_symlinks=False)
                except FileNotFoundError:
                    self.vanished = True
                    return
                if (info.st_dev, info.st_ino) != self.scope_identity:
                    raise RuntimeError('Owned cgroup inode changed')
                current = int(self._read(self.fd, 'memory.current'))
                peak = self._optional_peak()
                events = self._pairs(self._read(self.fd, 'memory.events'))
                stats = self._pairs(self._read(self.fd, 'memory.stat'))
                kernel = {'elapsed': round(now - self.started, 3), 'current': current, 'peak': peak,
                          'events': events, 'charged': {k: stats.get(k) for k in ('anon', 'file', 'kernel', 'slab', 'pagetables')}}
                self.last_kernel = kernel
                self.peak_current = current if self.peak_current is None else max(self.peak_current, current)
                self.ticks += 1
                if now >= self.next_timeline:
                    self._write('MEMORY-CGROUP.jsonl', (json.dumps(kernel, separators=(',', ':')) + '\n').encode())
                    self.next_timeline = now + 5
                self._stage()
                if self.api_start is None:
                    return
                pids = [int(x) for x in self._read(self.fd, 'cgroup.procs').split()]
                if len(set(pids)) != len(pids) or len(pids) > 256 or any(pid <= 0 for pid in pids):
                    raise RuntimeError('Owned PID bound')
                rows = {}
                for pid in pids:
                    try:
                        rows[pid] = self._process(pid)
                    except (FileNotFoundError, ProcessLookupError, ProcessSnapshotRace):
                        self.races += 1
                target = [x for x in rows.values() if x['namespacePids'][-1] == self.api_start['pid'] and x['birth'] == str(self.api_start['procBirthTicks'])]
                if len(target) > 1:
                    raise RuntimeError('Ambiguous API PID identity')
                target_pid = target[0]['hostPid'] if target else None
                for row in rows.values():
                    key = str(row['hostPid']) + ':' + row['birth']
                    if key not in self.processes and len(self.processes) >= 256:
                        raise RuntimeError('Lifetime API observation PID bound')
                    old = self.processes.get(key)
                    rss_values = [value for value in (row.get('VmRSS'), old.get('sampledVmRSSPeak') if old else None) if value is not None]
                    row['sampledVmRSSPeak'] = max(rss_values) if rss_values else None
                    # Only these structural identities are retained; no environment or raw argv/code.
                    self.processes[key] = row
                    relation = 'samePID-exec-image' if row['hostPid'] == target_pid else 'child-of-api-pid' if row['parentPid'] == target_pid else None
                    if row['isExpectedNative'] and row['nativeCanonicalArgv'] and relation:
                        self.native_bindings[key] = {'hostPid': row['hostPid'], 'birth': row['birth'],
                            'namespacePids': row['namespacePids'], 'relation': relation, 'nativeSHA256': self.native['sha256'],
                            'apiPidImageIsNative': target[0]['isExpectedNative'],
                            'sameDeviceInode': True, 'argvSHA256': row['argvSHA256'], 'sampledAt': round(now - self.started, 3)}
        except (FileNotFoundError, ProcessLookupError):
            # The cgroup can disappear after stat but before a counter read.
            # Preserve the last observed values; never replace them with zeros.
            if self.fd is not None and not self.scope.exists():
                self.vanished = True
            else:
                raise
        finally:
            self.max_tick_seconds = max(self.max_tick_seconds, time.monotonic() - began)

    def _check_limits(self):
        if int(self._read(self.fd, 'memory.max')) != 8589934592 or int(self._read(self.fd, 'memory.swap.max')) != 0 or int(self._read(self.fd, 'pids.max')) != 256:
            raise RuntimeError('Actual cgroup limits differ')
        quota, period = [int(x) for x in self._read(self.fd, 'cpu.max').split()]
        if quota != 2 * period:
            raise RuntimeError('Actual cgroup CPU quota differs')

    @staticmethod
    def _pairs(data):
        pairs = {}
        for line in data.decode('ascii').splitlines():
            key, number = line.split()
            if key in pairs or not number.isdigit():
                raise RuntimeError('Unknown kernel counter')
            pairs[key] = int(number)
        return pairs

    def _optional_peak(self):
        try:
            return int(self._read(self.fd, 'memory.peak'))
        except FileNotFoundError:
            return None

    def finish(self, cli_code, phase_error, owned_group_empty):
        if self.finalized:
            return
        self.finalized = True
        try:
            with bounded_call(2):
                reasons = []
                if self.scope_identity is None: reasons.append('scope-not-bound')
                if not self.ticks: reasons.append('no-kernel-samples')
                if self.api_start is None: reasons.append('api-launch-not-observed')
                if not self.native_bindings: reasons.append('native-exec-not-bound')
                basic = {'state': 'INCOMPLETE_OBSERVER_FINALIZATION_PENDING', 'cid': self.cid,
                         'ticks': self.ticks, 'coverageReasons': reasons,
                         'sampledCgroupCurrentPeak': self.peak_current,
                         'nativeBindingObserved': bool(self.native_bindings),
                         'normalCLIPipelineExit': cli_code, 'phaseError': str(phase_error)[:512] if phase_error else None,
                         'collectionContractSatisfied': False, 'noNativeExitCodeInferred': True}
                # Reserve a compact diagnostic before serializing any potentially large state.
                self._write('MEMORY-OBSERVATION.json', (json.dumps(basic, separators=(',', ':')) + '\n').encode())
                rows = sorted(self.processes.values(), key=lambda x: (not x['isExpectedNative'], -(x['sampledVmRSSPeak'] if x['sampledVmRSSPeak'] is not None else -1)))
                bindings = list(self.native_bindings.values())
                picked_rows, picked_bindings, used = [], [], 0
                budget = self.CAPS['MEMORY-PROCESS-SUMMARY.json'] - 1024
                for item in bindings:
                    size = len(json.dumps(item, separators=(',', ':')).encode()) + 1
                    if used + size <= budget:
                        picked_bindings.append(item); used += size
                for item in rows:
                    size = len(json.dumps(item, separators=(',', ':')).encode()) + 1
                    if used + size <= budget:
                        picked_rows.append(item); used += size
                omitted_rows, omitted_bindings = len(rows)-len(picked_rows), len(bindings)-len(picked_bindings)
                if omitted_rows: reasons.append('process-summary-rows-omitted')
                if omitted_bindings: reasons.append('native-binding-rows-omitted')
                processes = {'processes': picked_rows, 'nativeBindings': picked_bindings,
                             'omittedProcessRows': omitted_rows, 'omittedNativeBindings': omitted_bindings,
                             'peaksAreSampledLowerBounds': True, 'RSSSumWouldDoubleCountSharedPages': True}
                self._write('MEMORY-PROCESS-SUMMARY.json', (json.dumps(processes, separators=(',', ':')) + '\n').encode())
                summary = {'state': 'SAMPLED_RESOURCE_DIAGNOSTICS_NO_NATIVE_RAW_EXIT', 'cid': self.cid,
                           'verifiedContainerBinding': self.container_binding,
                           'freshNativeHostDeviceInode': self.native_identity,
                           'scope': str(self.scope), 'scopeDeviceInode': self.scope_identity, 'ticks': self.ticks,
                           'scopeVanished': self.vanished, 'lastKernelCounters': self.last_kernel,
                           'sampledCgroupCurrentPeak': self.peak_current, 'processRaces': self.races,
                           'nativeBindingObserved': bool(self.native_bindings), 'maxTickSeconds': self.max_tick_seconds,
                           'polls': self.polls, 'kernelProcInputBytes': self.total_input_bytes,
                           'boundedInputReadCalls': self.total_read_calls,
                           'normalCLIPipelineExit': cli_code, 'phaseError': str(phase_error)[:512] if phase_error else None,
                           'ownedCLIGroupEmpty': owned_group_empty, 'noNativeExitCodeInferred': True,
                           'coverageReasons': reasons, 'collectionContractSatisfied': not reasons and not phase_error and owned_group_empty,
                           'finalKernelCounterState': 'unknown-after-vanish' if self.vanished else 'last-sample-only',
                           'completeNativeLifecycleOrExactPeakClaimed': False,
                           'vanishedOrUnobservedCountersAreUnknownNotZero': True,
                           'diagnosticCaps': self.CAPS, 'elapsedSeconds': time.monotonic() - self.started}
                self._write('MEMORY-FINALIZATION.json', (json.dumps(summary, separators=(',', ':')) + '\n').encode())
        finally:
            self._close()

    def _close(self):
        errors = []
        for fd in list(self._fds):
            try:
                self._release(fd)
            except OSError as error:
                errors.append(error.errno)
        self.files = {}
        self.fd = None
        if errors or self._fds:
            raise RuntimeError('Observer descriptor closure incomplete: ' + str(errors))
