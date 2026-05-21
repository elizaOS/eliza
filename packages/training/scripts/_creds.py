"""Centralized credential broker for training-pipeline scripts (SOC2 CC6.1).

All training scripts that need ``HF_TOKEN``, ``VAST_API_KEY``,
``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY`` (or any future provider
credential) MUST route their reads through this module instead of poking
``os.environ`` directly. The module guarantees:

  1. **One source of truth for resolution order.** Env first; optionally a
     Steward credential-proxy HTTP endpoint when
     ``ELIZA_STEWARD_CREDS_URL`` is set. (Endpoint contract is documented
     in ``packages/training/SECURITY.md`` and tracked as an open question
     against the Steward team in ``STEWARD-KMS-SPEC.md``.)
  2. **Audit-friendly access logs.** Every successful resolution logs (via
     the structured logger) the credential name, a fingerprint
     (``last4 + sha256``), the caller (script filename), and a UTC
     timestamp. The credential value itself is NEVER logged.
  3. **No accidental leakage.** The module returns ``None`` rather than
     empty strings when a credential is absent; consumer scripts decide
     whether the absence is fatal.

SOC2 mapping: CC6.1 (logical access), CC7.2 (monitoring).
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Final

log = logging.getLogger("training.creds")

# ---------------------------------------------------------------------------
# Canonical credential names
# ---------------------------------------------------------------------------

CRED_HF_TOKEN: Final[str] = "HF_TOKEN"
CRED_HF_TOKEN_ALIASES: Final[tuple[str, ...]] = (
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
)
CRED_VAST_API_KEY: Final[str] = "VAST_API_KEY"
CRED_AWS_ACCESS_KEY_ID: Final[str] = "AWS_ACCESS_KEY_ID"
CRED_AWS_SECRET_ACCESS_KEY: Final[str] = "AWS_SECRET_ACCESS_KEY"

KNOWN_CREDS: Final[frozenset[str]] = frozenset(
    {
        CRED_HF_TOKEN,
        CRED_VAST_API_KEY,
        CRED_AWS_ACCESS_KEY_ID,
        CRED_AWS_SECRET_ACCESS_KEY,
    }
)

# The Steward credential-proxy URL. When set, the broker first asks Steward;
# falls back to env on any failure. The exact contract is TODO; the open
# question is tracked in STEWARD-KMS-SPEC.md.
STEWARD_URL_ENV: Final[str] = "ELIZA_STEWARD_CREDS_URL"
STEWARD_TIMEOUT_SEC: Final[float] = 2.0


@dataclass(frozen=True)
class CredentialFingerprint:
    name: str
    last4: str
    sha256_prefix: str  # 12 hex chars; full sha256 in audit log only
    source: str  # "env" | "steward" | "missing"


def _fingerprint(name: str, value: str | None, source: str) -> CredentialFingerprint:
    if not value:
        return CredentialFingerprint(name=name, last4="", sha256_prefix="", source=source)
    last4 = value[-4:] if len(value) >= 4 else "*" * len(value)
    h = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return CredentialFingerprint(
        name=name,
        last4=last4,
        sha256_prefix=h[:12],
        source=source,
    )


def _emit_access_event(fp: CredentialFingerprint) -> None:
    """Structured audit log line. Never includes the secret value itself."""
    caller = sys.argv[0] or "<unknown>"
    log.info(
        "creds.access name=%s source=%s last4=%s sha256_prefix=%s caller=%s ts=%s",
        fp.name,
        fp.source,
        fp.last4 or "(none)",
        fp.sha256_prefix or "(none)",
        caller,
        int(time.time()),
    )


def _from_steward(name: str) -> str | None:
    url = os.environ.get(STEWARD_URL_ENV, "").strip()
    if not url:
        return None
    target = f"{url.rstrip('/')}/v1/creds/{name}"
    try:
        req = urllib.request.Request(target, method="GET")
        with urllib.request.urlopen(req, timeout=STEWARD_TIMEOUT_SEC) as resp:
            if resp.status != 200:
                log.warning("steward creds: status=%s name=%s", resp.status, name)
                return None
            body = resp.read().decode("utf-8").strip()
            return body or None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        # Steward unavailable -> fall back to env; treat as advisory.
        log.warning("steward creds unreachable for %s: %s", name, exc)
        return None


def get_credential(
    name: str,
    *,
    aliases: tuple[str, ...] = (),
    required: bool = False,
) -> str | None:
    """Resolve a credential by canonical name and (optional) aliases.

    Lookup order:
      1. Steward proxy if ``ELIZA_STEWARD_CREDS_URL`` is set.
      2. ``os.environ[name]``.
      3. ``os.environ[alias]`` for each alias in order.

    On success, emits a structured ``creds.access`` audit log line with a
    fingerprint of the credential (NEVER the value). On absence, returns
    ``None`` (or raises ``KeyError`` if ``required=True``).
    """
    if name not in KNOWN_CREDS:
        log.debug("creds.access of unknown credential %r — allowed but tracked", name)

    value = _from_steward(name)
    source = "steward" if value else None
    if not value:
        for cand in (name, *aliases):
            v = os.environ.get(cand, "").strip()
            if v:
                value = v
                source = "env"
                break

    if not value:
        fp = _fingerprint(name, None, "missing")
        _emit_access_event(fp)
        if required:
            raise KeyError(
                f"required credential {name!r} not found in env or Steward"
            )
        return None

    fp = _fingerprint(name, value, source or "env")
    _emit_access_event(fp)
    return value


def hf_token(required: bool = False) -> str | None:
    """Convenience accessor for the HuggingFace token."""
    return get_credential(
        CRED_HF_TOKEN,
        aliases=tuple(a for a in CRED_HF_TOKEN_ALIASES if a != CRED_HF_TOKEN),
        required=required,
    )


def vast_api_key(required: bool = False) -> str | None:
    return get_credential(CRED_VAST_API_KEY, required=required)


def aws_credentials() -> tuple[str | None, str | None]:
    return (
        get_credential(CRED_AWS_ACCESS_KEY_ID),
        get_credential(CRED_AWS_SECRET_ACCESS_KEY),
    )
