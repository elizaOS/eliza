"""BackendAdapter protocol — the abstraction every cloud GPU backend
must implement so the orchestrator can stay backend-agnostic.

The vast.ai bash launcher (``scripts/train_vast.sh``) is the reference
implementation in legacy form. ``VastBackend`` re-expresses every step it
performs (search → provision → sync → run → status → teardown) as
typed Python so other backends (Nebius, RunPod, local-docker, Lambda)
can drop in by satisfying this same Protocol.

This module is **non-breaking**: nothing in ``train_vast.sh`` or
``scripts/lib/vast.py`` imports from here. New code paths build on this
Protocol; legacy paths keep working unchanged.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OfferConstraints:
    """Filter criteria used to narrow a backend's offer catalog.

    ``gpu_target`` is a backend-specific token (e.g. vast's
    ``"b200-2x"``). Adapters are responsible for translating it into
    their native search vocabulary; cross-backend mapping lives in the
    orchestrator, not here.
    """

    gpu_target: str
    min_disk_gb: int = 500
    min_inet_down_mbps: int = 500
    min_reliability: float = 0.97
    min_duration_days: float = 3.0
    max_dph: float | None = None


@dataclass(frozen=True)
class Offer:
    """A normalized rental offer from any backend."""

    backend: str
    id: str
    gpu_name: str
    num_gpus: int
    gpu_total_ram_gb: int
    dph: float
    reliability: float
    inet_down_mbps: float
    disk_space_gb: float
    geolocation: str
    raw: Mapping[str, object]


@dataclass(frozen=True)
class InstanceHandle:
    """Opaque pointer to a provisioned instance.

    ``backend`` + ``instance_id`` together uniquely identify an
    instance across the world. ``label`` is the human tag the operator
    set at provision time; ``created_at`` is a unix timestamp.
    """

    backend: str
    instance_id: str
    label: str
    created_at: float


@dataclass(frozen=True)
class InstanceStatus:
    """Snapshot of an instance's runtime state.

    ``state`` is normalized to one of:
      ``loading``    — booting, image pull, OS init in progress
      ``running``    — ready for ssh / training
      ``stopped``    — paused but not destroyed (billing may continue)
      ``destroyed``  — gone; will not come back
      ``unknown``    — backend returned a state we don't recognize

    ``public_endpoint`` is the canonical reachable address (e.g.
    ``"ssh://root@host:port"`` or ``"http://host:8080"``); ``None``
    when the instance has no exposed surface yet.
    """

    state: str
    gpu_name: str
    num_gpus: int
    uptime_s: float | None
    public_endpoint: str | None
    raw: Mapping[str, object]


@dataclass(frozen=True)
class ExitCode:
    """Result of a remote command invocation."""

    code: int
    duration_s: float


# ---------------------------------------------------------------------------
# Typed exceptions
# ---------------------------------------------------------------------------


class BackendError(RuntimeError):
    """Base for every backend-originated failure."""


class NoOffersError(BackendError):
    """``search_offers`` returned an empty list for the given constraints."""


class ProvisionError(BackendError):
    """``provision`` failed before an instance handle could be created."""


class InstanceNotFoundError(BackendError):
    """The referenced instance does not exist (or has been destroyed)."""


class SshUnreachableError(BackendError):
    """SSH endpoint not yet reachable; usually transient during loading."""


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class BackendAdapter(Protocol):
    """The contract every cloud GPU backend implements.

    Implementations must be cheap to construct (no network I/O in
    ``__init__``); all I/O happens in the methods below. Methods raise
    ``BackendError`` (or a subclass) on failure — adapters must not
    swallow errors silently.
    """

    name: str

    def search_offers(self, c: OfferConstraints) -> list[Offer]:
        """Return all offers matching ``c``, sorted cheapest first."""
        ...

    def provision(
        self,
        offer_id: str,
        *,
        disk_gb: int,
        image: str,
        ssh_pubkey_path: Path,
        label: str,
    ) -> InstanceHandle:
        """Create an instance from ``offer_id``. Raises ``ProvisionError``."""
        ...

    def wait_running(self, h: InstanceHandle, *, timeout_s: int = 1200) -> None:
        """Block until the instance reports ``state == 'running'``."""
        ...

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
        """Copy ``src`` (local) to ``dst`` (remote path on the instance)."""
        ...

    def run_remote(
        self,
        h: InstanceHandle,
        command: str,
        *,
        env: Mapping[str, str] = {},
        stream: bool = True,
        timeout_s: int | None = None,
    ) -> ExitCode:
        """Execute ``command`` on the instance over SSH."""
        ...

    def sync_from(
        self,
        h: InstanceHandle,
        src: str,
        dst: Path,
        *,
        includes: Iterable[str] = (),
        excludes: Iterable[str] = (),
    ) -> None:
        """Copy ``src`` (remote) to ``dst`` (local path)."""
        ...

    def status(self, h: InstanceHandle) -> InstanceStatus:
        """Return the current ``InstanceStatus``."""
        ...

    def teardown(self, h: InstanceHandle, *, force: bool = False) -> None:
        """Destroy the instance. Idempotent — calling on an already-destroyed
        instance must succeed (with a warning) rather than raise."""
        ...


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


BACKEND_REGISTRY: dict[str, type] = {}


def register_backend(name: str) -> Callable[[type], type]:
    """Class decorator that registers a ``BackendAdapter`` implementation
    under ``name`` so the CLI can resolve it by string.

    Usage::

        @register_backend("vast")
        class VastBackend:
            ...
    """

    def decorate(cls: type) -> type:
        if name in BACKEND_REGISTRY:
            raise ValueError(
                f"backend {name!r} already registered to {BACKEND_REGISTRY[name]!r}"
            )
        BACKEND_REGISTRY[name] = cls
        return cls

    return decorate
