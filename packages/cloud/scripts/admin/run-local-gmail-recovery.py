#!/usr/bin/env python3
"""Run synthetic recovery in an owned PG18 container. Never accepts a database URL."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import time

IMAGE = 'pgvector/pgvector@sha256:ad249f9fb9572979643a47694e59b9a8cdcdf6abc6accebf49bb80ad5f20ff9b'
RESERVE = 22 * 1024**3
ROOT = Path(__file__).resolve().parents[4]


def run(args, env=None):
    return subprocess.run(args, env=env, check=True, capture_output=True, text=True, timeout=60).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bun', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    bun = options.bun.resolve(strict=True)
    if run([str(bun), '--version']) != '1.4.2':
        raise RuntimeError('pinned_bun_required')
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    receipt = {'purpose': 'synthetic_rehearsal_only', 'image': IMAGE, 'status': 'not_started'}
    container = 'eliza-recovery-' + secrets.token_hex(8)
    ownership = secrets.token_hex(16)
    receipt['launcherPid'] = os.getpid()
    receipt['containerName'] = container
    receipt['ownershipLabel'] = ownership
    receipt['sourceFiles'] = {
        name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
        for name in ('run-local-gmail-recovery.py', 'run-local-gmail-recovery-worker.ts',
                     'rehearse-exact-gmail-recovery.ts', 'exact-gmail-ledger-recovery.ts',
                     'recovery-transaction-boundary.ts', 'gmail-recovery-catalog.ts',
                     'canonical-migration-ledger.ts', 'migrate-with-diagnostics.ts',
                     'fixtures/gmail-recovery-catalog.json',
                     'fixtures/gmail-recovery-catalog-pg18.json')
    }

    def persist():
        temporary = output / 'launcher-receipt.json.tmp'
        with temporary.open('w') as handle:
            json.dump(receipt, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output / 'launcher-receipt.json')

    worker = None

    class Interrupted(Exception):
        pass

    def interrupt(_number, _frame):
        raise Interrupted()

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    persist()
    try:
        if shutil.disk_usage(ROOT).free < RESERVE:
            raise RuntimeError('disk_reserve_required')
        # Inspect only: pulling is a separately coordinated operation.
        run(['docker', 'image', 'inspect', IMAGE])
        password = secrets.token_hex(32)
        docker_env = dict(os.environ, POSTGRES_PASSWORD=password)
        receipt['status'] = 'starting_container'
        persist()
        run(['docker', 'run', '--detach', '--pull=never', '--name', container,
             '--label', f'eliza.synthetic-recovery={ownership}', '--cpus=2', '--memory=3g',
             '--memory-swap=3g', '--pids-limit=128', '--shm-size=128m',
             '--tmpfs', '/var/lib/postgresql:rw,size=1073741824',
             '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD',
             '--env', 'POSTGRES_USER=postgres', '--env', 'POSTGRES_DB=postgres', IMAGE], docker_env)
        receipt['status'] = 'container_started'
        persist()
        binding = run(['docker', 'port', container, '5432/tcp'])
        host, port = binding.split(':')
        if host != '127.0.0.1' or not port.isdigit():
            raise RuntimeError('loopback_binding_required')
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('postgres_start_timeout')
        url = f'postgresql://postgres:{password}@127.0.0.1:{port}/postgres'
        # No inherited cloud credentials, provider URLs, or database configuration.
        env = {'PATH': f'{bun.parent}:/usr/bin:/bin',
               'NODE_ENV': 'test', 'DATABASE_URL': url, 'REHEARSAL_DATABASE_URL': url,
               'REHEARSAL_SYNTHETIC_ONLY': '1',
               'REHEARSAL_RECEIPT_PATH': str(output / 'worker-receipt.json')}
        with (output / 'synthetic-worker.log').open('wb') as log:
            worker = subprocess.Popen([str(bun), '--no-env-file', str(Path(__file__).with_name('run-local-gmail-recovery-worker.ts'))],
                                      cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
            deadline = time.monotonic() + 1800
            receipt['status'] = 'running'
            receipt['workerPid'] = worker.pid
            persist()
            while worker.poll() is None:
                if shutil.disk_usage(ROOT).free < RESERVE or time.monotonic() > deadline:
                    os.killpg(worker.pid, signal.SIGTERM)
                    receipt['status'] = 'resource_stop'
                    break
                time.sleep(2)
            try:
                code = worker.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(worker.pid, signal.SIGKILL)
                code = worker.wait()
            receipt['workerExitCode'] = code
            if receipt['status'] == 'running':
                receipt['status'] = 'passed' if code == 0 else 'failed'
    except Interrupted:
        receipt['status'] = 'interrupted'
    except Exception:
        # No raw Docker/driver error or synthetic password reaches the operator receipt.
        receipt['status'] = 'launcher_failed'
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if worker is not None and worker.poll() is None:
            os.killpg(worker.pid, signal.SIGKILL)
            worker.wait()
        # docker run can create the container before its client fails. Identify it
        # by both our unpredictable name and per-run label before removing it.
        try:
            inspect = subprocess.run(['docker', 'inspect', '--type=container', container],
                                     capture_output=True, text=True, timeout=20)
            if inspect.returncode == 0:
                metadata = json.loads(inspect.stdout)
                if len(metadata) != 1 or metadata[0]['Config']['Labels'].get('eliza.synthetic-recovery') != ownership:
                    raise RuntimeError('owned_container_identity_mismatch')
                result = subprocess.run(['docker', 'rm', '--force', '--volumes', container],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                receipt['ownedContainerRemoved'] = result.returncode == 0
                if result.returncode:
                    raise RuntimeError('owned_container_cleanup_failed')
            else:
                # A daemon failure cannot establish that no container remains.
                listed = run(['docker', 'container', 'ls', '--all', '--format', '{{.Names}}'])
                if container in listed.splitlines():
                    raise RuntimeError('owned_container_cleanup_unconfirmed')
                receipt['ownedContainerAbsent'] = True
        except Exception:
            receipt['status'] = 'cleanup_unconfirmed'
        receipt['freeAfter'] = shutil.disk_usage(ROOT).free
        persist()
    print(json.dumps(receipt))
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
