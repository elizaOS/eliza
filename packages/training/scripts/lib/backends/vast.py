"""Vast.ai implementation of the ``BackendAdapter`` Protocol.

Re-expresses every step the legacy ``scripts/train_vast.sh`` performs as
typed Python. The legacy bash launcher continues to work unchanged —
this adapter is a parallel path other orchestrators can consume.

Internally, search/wait/ssh-endpoint resolution is delegated to the
existing ``scripts/lib/vast`` low-level CLI shim; provision / sync /
run / status / teardown call the ``vastai``, ``rsync``, and ``ssh``
binaries directly.
"""

from __future__ import annotations

import json
import logging
import shlex
import subprocess
import sys
import time
from collections.abc import Iterable, Mapping
from pathlib import Path

from scripts.lib import vast as _vast_cli
from scripts.lib.backends.base import (
    BackendError,
    ExitCode,
    InstanceHandle,
    InstanceNotFoundError,
    InstanceStatus,
    NoOffersError,
    Offer,
    OfferConstraints,
    ProvisionError,
    SshUnreachableError,
    register_backend,
)

logger = logging.getLogger(__name__)


# Map InstanceStatus.state vocabulary to vastai's ``actual_status`` /
# ``cur_state`` strings. Anything not in this table falls through to
# ``unknown`` so downstream code can refuse to act on garbage.
_VAST_STATE_MAP: dict[str, str] = {
    "running": "running",
    "loading": "loading",
    "scheduling": "loading",
    "created": "loading",
    "stopped": "stopped",
    "exited": "stopped",
    "destroyed": "destroyed",
}


@register_backend("vast")
class VastBackend:
    """``BackendAdapter`` implementation for vast.ai."""

    name = "vast"

    # ----- offers ----------------------------------------------------------

    def search_offers(self, c: OfferConstraints) -> list[Offer]:
        try:
            raw_offers = _vast_cli.search(
                c.gpu_target,
                min_reliability=c.min_reliability,
                min_inet_down_mbps=float(c.min_inet_down_mbps),
                min_disk_gb=float(c.min_disk_gb),
                min_duration_days=c.min_duration_days,
            )
        except SystemExit as e:
            # _vast_cli.search() raises SystemExit for unknown gpu_target.
            raise BackendError(str(e)) from e
        except subprocess.CalledProcessError as e:
            raise BackendError(
                f"vastai search offers failed: {e.stderr or e.stdout or e}"
            ) from e

        offers: list[Offer] = []
        for raw in raw_offers:
            if c.max_dph is not None and raw.dph_total > c.max_dph:
                continue
            offers.append(
                Offer(
                    backend=self.name,
                    id=str(raw.id),
                    gpu_name=raw.gpu_name,
                    num_gpus=raw.num_gpus,
                    gpu_total_ram_gb=raw.gpu_total_ram_gb,
                    dph=raw.dph_total,
                    reliability=raw.reliability,
                    inet_down_mbps=raw.inet_down_mbps,
                    disk_space_gb=raw.disk_space_gb,
                    geolocation=raw.geolocation,
                    raw=raw.__dict__,
                )
            )
        if not offers:
            raise NoOffersError(
                f"no vast offers match {c} "
                f"(target={c.gpu_target}, min_disk={c.min_disk_gb}GB, "
                f"min_inet={c.min_inet_down_mbps}Mbps, "
                f"min_reliability={c.min_reliability}, "
                f"min_duration_days={c.min_duration_days}, max_dph={c.max_dph})"
            )
        return offers

    # ----- provisioning ----------------------------------------------------

    def provision(
        self,
        offer_id: str,
        *,
        disk_gb: int,
        image: str,
        ssh_pubkey_path: Path,
        label: str,
    ) -> InstanceHandle:
        if not ssh_pubkey_path.is_file():
            raise ProvisionError(f"ssh public key not found: {ssh_pubkey_path}")

        cmd = [
            "vastai", "create", "instance", str(offer_id),
            "--image", image,
            "--disk", str(disk_gb),
            "--label", label,
            "--ssh",
            "--direct",
            "--cancel-unavail",
            "--raw",
        ]
        try:
            proc = subprocess.run(cmd, check=True, text=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            raise ProvisionError(
                f"vastai create instance failed (offer={offer_id}): "
                f"{e.stderr or e.stdout or e}"
            ) from e

        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            raise ProvisionError(
                f"vastai create instance returned non-JSON: {proc.stdout!r}"
            ) from e
        new_id = payload.get("new_contract")
        if not new_id:
            raise ProvisionError(
                f"vastai create instance succeeded but no new_contract in: {payload!r}"
            )

        # Attach the ssh key so subsequent ssh commands authenticate.
        pubkey = ssh_pubkey_path.read_text().strip()
        try:
            subprocess.run(
                ["vastai", "attach", "ssh", str(new_id), pubkey],
                check=True, text=True, capture_output=True,
            )
        except subprocess.CalledProcessError as e:
            raise ProvisionError(
                f"vastai attach ssh failed for {new_id}: "
                f"{e.stderr or e.stdout or e}"
            ) from e

        return InstanceHandle(
            backend=self.name,
            instance_id=str(new_id),
            label=label,
            created_at=time.time(),
        )

    # ----- lifecycle -------------------------------------------------------

    def wait_running(self, h: InstanceHandle, *, timeout_s: int = 1200) -> None:
        try:
            _vast_cli.wait_running(int(h.instance_id), timeout_s=timeout_s)
        except SystemExit as e:
            raise SshUnreachableError(
                f"instance {h.instance_id} did not reach 'running' "
                f"within {timeout_s}s: {e}"
            ) from e

        # Once vast says 'running', confirm the bouncer ssh port is
        # advertised — otherwise sync_to / run_remote will explode at
        # the first rsync. ssh_endpoint() retries for ~30s internally.
        try:
            _vast_cli.ssh_endpoint(int(h.instance_id))
        except SystemExit as e:
            raise SshUnreachableError(str(e)) from e

    # ----- I/O -------------------------------------------------------------

    def _ssh_endpoint(self, h: InstanceHandle) -> tuple[str, str, int]:
        try:
            return _vast_cli.ssh_endpoint(int(h.instance_id))
        except SystemExit as e:
            raise SshUnreachableError(str(e)) from e

    def _rsync(
        self,
        h: InstanceHandle,
        *,
        src: str,
        dst: str,
        excludes: Iterable[str],
        includes: Iterable[str],
        delete: bool,
    ) -> None:
        user, host, port = self._ssh_endpoint(h)
        ssh_cmd = (
            f"ssh -p {port} "
            f"-o StrictHostKeyChecking=no "
            f"-o UserKnownHostsFile=/dev/null"
        )
        cmd: list[str] = [
            "rsync", "-avh", "--partial", "--info=progress2",
            "-e", ssh_cmd,
        ]
        if delete:
            cmd.append("--delete")
        for inc in includes:
            cmd.extend(["--include", inc])
        for exc in excludes:
            cmd.extend(["--exclude", exc])
        # Substitute remote-tagged endpoints once we have user@host.
        cmd.append(src.replace("__REMOTE__", f"{user}@{host}"))
        cmd.append(dst.replace("__REMOTE__", f"{user}@{host}"))

        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError as e:
            raise BackendError(
                f"rsync failed (instance {h.instance_id}, src={src!r}, "
                f"dst={dst!r}): exit={e.returncode}"
            ) from e

    def sync_to(
        self,
        h: InstanceHandle,
        src: Path,
        dst: str,
        *,
        excludes: Iterable[str] = (),
        includes: Iterable[str] = (),
        delete: bool = False,
    ) -> None:
        self._rsync(
            h,
            src=str(src),
            dst=f"__REMOTE__:{dst}",
            excludes=excludes,
            includes=includes,
            delete=delete,
        )

    def sync_from(
        self,
        h: InstanceHandle,
        src: str,
        dst: Path,
        *,
        includes: Iterable[str] = (),
        excludes: Iterable[str] = (),
    ) -> None:
        self._rsync(
            h,
            src=f"__REMOTE__:{src}",
            dst=str(dst),
            excludes=excludes,
            includes=includes,
            delete=False,
        )

    def run_remote(
        self,
        h: InstanceHandle,
        command: str,
        *,
        env: Mapping[str, str] = {},
        stream: bool = True,
        timeout_s: int | None = None,
    ) -> ExitCode:
        user, host, port = self._ssh_endpoint(h)
        # Inline env exports so callers don't need to thread shell quoting.
        if env:
            prefix = " ".join(
                f"{k}={shlex.quote(v)}" for k, v in env.items()
            )
            remote_cmd = f"export {prefix}; {command}"
        else:
            remote_cmd = command

        ssh_args = [
            "ssh",
            "-p", str(port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ServerAliveInterval=30",
        ]
        if stream:
            # -tt forces a pty so the remote process tree dies when the
            # local ssh dies (matches train_vast.sh's ssh_run behavior).
            ssh_args.append("-tt")
        ssh_args.append(f"{user}@{host}")
        ssh_args.append(remote_cmd)

        start = time.monotonic()
        try:
            if stream:
                rc = subprocess.run(
                    ssh_args,
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                    timeout=timeout_s,
                ).returncode
            else:
                rc = subprocess.run(
                    ssh_args,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                ).returncode
        except subprocess.TimeoutExpired as e:
            raise BackendError(
                f"ssh command timed out after {timeout_s}s on "
                f"{h.instance_id}: {command!r}"
            ) from e
        return ExitCode(code=rc, duration_s=time.monotonic() - start)

    # ----- status / teardown ----------------------------------------------

    def status(self, h: InstanceHandle) -> InstanceStatus:
        try:
            info = _vast_cli.show_instance(int(h.instance_id))
        except subprocess.CalledProcessError as e:
            raise InstanceNotFoundError(
                f"vast instance {h.instance_id} not found: "
                f"{e.stderr or e.stdout or e}"
            ) from e

        if not info:
            raise InstanceNotFoundError(
                f"vast instance {h.instance_id} returned empty payload"
            )

        raw_state = (
            info.get("actual_status")
            or info.get("cur_state")
            or info.get("intended_status")
            or ""
        )
        state = _VAST_STATE_MAP.get(str(raw_state), "unknown")

        start = info.get("start_date") or 0
        uptime_s: float | None = None
        if start:
            uptime_s = max(0.0, time.time() - float(start))

        endpoint: str | None = None
        ssh_host = info.get("ssh_host")
        ssh_port = info.get("ssh_port")
        if ssh_host and ssh_port:
            endpoint = f"ssh://root@{ssh_host}:{int(ssh_port)}"

        gpu_name = str(info.get("gpu_name", "?"))
        # ``num_gpus`` is sometimes reported as a string by vast; coerce.
        try:
            num_gpus = int(info.get("num_gpus", 0))
        except (TypeError, ValueError):
            num_gpus = 0

        return InstanceStatus(
            state=state,
            gpu_name=gpu_name,
            num_gpus=num_gpus,
            uptime_s=uptime_s,
            public_endpoint=endpoint,
            raw=info,
        )

    def teardown(self, h: InstanceHandle, *, force: bool = False) -> None:
        cmd = ["vastai", "destroy", "instance", h.instance_id]
        try:
            subprocess.run(cmd, check=True, text=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            stderr = (e.stderr or "") + (e.stdout or "")
            # Vast returns non-zero for "instance does not exist" — treat
            # that as success since teardown is documented as idempotent.
            stderr_l = stderr.lower()
            if any(token in stderr_l for token in (
                "no such instance", "not found", "does not exist", "destroyed",
            )):
                logger.warning(
                    "vast instance %s already destroyed (idempotent teardown)",
                    h.instance_id,
                )
                return
            raise BackendError(
                f"vastai destroy instance failed for {h.instance_id}: "
                f"{stderr or e}"
            ) from e


# Re-export for ``from scripts.lib.backends.vast import VastBackend`` callers.
__all__ = ["VastBackend"]
