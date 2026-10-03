"""Deployable trusted-evidence server backed by a native elizaOS runtime."""

from __future__ import annotations

import base64
import binascii
import logging
import os
from datetime import timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import cast

from .runtime_connector import (
    ElizaRuntimeActionConnector,
    production_parent_contract_registry,
)
from .trusted_executor_server import (
    SqliteReplayStore,
    TrustedExecutorApplication,
    make_trusted_executor_handler,
)
from .types import TrustedEvidenceBoundary

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _hmac_key(name: str) -> bytes:
    encoded = _required(name)
    try:
        key = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise SystemExit(f"{name} is not valid base64") from exc
    if len(key) < 32:
        raise SystemExit(f"{name} must decode to at least 32 bytes")
    return key


def main() -> None:
    """Validate deployment configuration and serve signed evidence."""
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    host = os.environ.get(
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_HOST",
        "127.0.0.1",
    ).strip()
    if host not in _LOOPBACK_HOSTS:
        raise SystemExit(
            "the built-in trusted executor serves loopback HTTP only; "
            "put an authenticated TLS reverse proxy in front for remote access"
        )
    try:
        port = int(
            os.environ.get(
                "LIFEOPS_BENCH_TRUSTED_EXECUTOR_PORT",
                "3942",
            )
        )
    except ValueError as exc:
        raise SystemExit(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_PORT is invalid"
        ) from exc
    if port <= 0 or port > 65535:
        raise SystemExit(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_PORT is invalid"
        )
    request_key = _hmac_key(
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_HMAC_KEY_B64"
    )
    receipt_key = _hmac_key(
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_HMAC_KEY_B64"
    )
    replay_path = Path(
        _required("LIFEOPS_BENCH_TRUSTED_EXECUTOR_REPLAY_DB")
    ).expanduser()
    if not replay_path.is_absolute():
        raise SystemExit(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REPLAY_DB must be absolute"
        )
    connector = ElizaRuntimeActionConnector(
        url=_required("LIFEOPS_BENCH_TRUSTED_RUNTIME_URL"),
        bearer_token=_required("LIFEOPS_BENCH_TRUSTED_RUNTIME_TOKEN"),
        timeout_s=float(
            os.environ.get(
                "LIFEOPS_BENCH_TRUSTED_RUNTIME_TIMEOUT_S",
                "30",
            )
        ),
    )
    application = TrustedExecutorApplication(
        request_hmac_key=request_key,
        request_key_id=_required(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_KEY_ID"
        ),
        receipt_hmac_key=receipt_key,
        receipt_key_id=_required(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_KEY_ID"
        ),
        provider=_required(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_PROVIDER"
        ),
        boundary=cast_boundary(
            os.environ.get(
                "LIFEOPS_BENCH_TRUSTED_EXECUTOR_BOUNDARY",
                "sandbox_connector",
            ).strip()
        ),
        executor_version="eliza-runtime-executor-v1",
        contracts=production_parent_contract_registry(),
        connector=connector,
        replay_store=SqliteReplayStore(replay_path),
        request_ttl=timedelta(
            seconds=float(
                os.environ.get(
                    "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_TTL_S",
                    "120",
                )
            )
        ),
    )
    server = ThreadingHTTPServer(
        (host, port),
        make_trusted_executor_handler(application),
    )
    server.daemon_threads = True
    logging.getLogger(__name__).info(
        "[TrustedExecutorCLI] listening on %s:%d", host, port
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def cast_boundary(value: str) -> TrustedEvidenceBoundary:
    """Validate the only evidence-boundary values accepted by the protocol."""
    if value not in {"sandbox_connector", "production_connector"}:
        raise SystemExit(
            "LIFEOPS_BENCH_TRUSTED_EXECUTOR_BOUNDARY must be "
            "sandbox_connector or production_connector"
        )
    return cast(TrustedEvidenceBoundary, value)


if __name__ == "__main__":
    main()
