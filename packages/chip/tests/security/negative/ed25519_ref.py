"""Ed25519 (RFC 8032) signing/verify for the W7 negative-evidence harness.

Provides a stable interface independent of which interpreter runs the harness:

  Ed25519PrivateKey(seed_32b)      -> deterministic key from a 32-byte seed
    .public_bytes() -> 32 B raw public key
    .sign(msg)      -> 64 B raw signature
  ed25519_verify_raw(sig, pub, msg) -> bool

Backend preference, all RFC 8032 compliant so a wrong key or flipped byte is a
GENUINE cryptographic rejection, never a stub:
  1. `cryptography` (OpenSSL Ed25519) — present in both the repo .venv and the
     system interpreter.
  2. `nacl` (libsodium) — fallback.
  3. Pure-Python RFC 8032 reference (self-contained, no third-party dep) so the
     harness still runs on a bare interpreter. This mirrors the appendix code
     of RFC 8032 §6 and is for test-vector generation only, not production.

The mask-ROM verifier (fw/boot-rom/secure/ed25519_ct.c) implements the same
RFC 8032 verify path; this module exists only to build/break the test images.
"""

from __future__ import annotations

_BACKEND: str


def _load_cryptography():
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey as _Priv,
    )
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PublicKey as _Pub,
    )

    raw = serialization.Encoding.Raw
    pub_fmt = serialization.PublicFormat.Raw

    class _Key:
        def __init__(self, seed: bytes):
            if len(seed) != 32:
                raise ValueError("seed must be 32 bytes")
            self._k = _Priv.from_private_bytes(seed)

        def public_bytes(self) -> bytes:
            return self._k.public_key().public_bytes(raw, pub_fmt)

        def sign(self, msg: bytes) -> bytes:
            return self._k.sign(msg)

    def _verify(sig: bytes, pub: bytes, msg: bytes) -> bool:
        try:
            _Pub.from_public_bytes(pub).verify(sig, msg)
            return True
        except (InvalidSignature, ValueError):
            return False

    return _Key, _verify


def _load_nacl():
    from nacl.exceptions import BadSignatureError
    from nacl.signing import SigningKey, VerifyKey

    class _Key:
        def __init__(self, seed: bytes):
            if len(seed) != 32:
                raise ValueError("seed must be 32 bytes")
            self._k = SigningKey(seed)

        def public_bytes(self) -> bytes:
            return bytes(self._k.verify_key)

        def sign(self, msg: bytes) -> bytes:
            return self._k.sign(msg).signature

    def _verify(sig: bytes, pub: bytes, msg: bytes) -> bool:
        try:
            VerifyKey(pub).verify(msg, sig)
            return True
        except (BadSignatureError, ValueError):
            return False

    return _Key, _verify


def _load_pure():
    import ed25519_pure as P

    class _Key:
        def __init__(self, seed: bytes):
            if len(seed) != 32:
                raise ValueError("seed must be 32 bytes")
            self._seed = seed
            self._pub = P.public_key(seed)

        def public_bytes(self) -> bytes:
            return self._pub

        def sign(self, msg: bytes) -> bytes:
            return P.sign(self._seed, self._pub, msg)

    def _verify(sig: bytes, pub: bytes, msg: bytes) -> bool:
        return P.verify(pub, msg, sig)

    return _Key, _verify


for _name, _loader in (
    ("cryptography", _load_cryptography),
    ("nacl", _load_nacl),
    ("pure", _load_pure),
):
    try:
        Ed25519PrivateKey, ed25519_verify_raw = _loader()
        _BACKEND = _name
        break
    except Exception:  # noqa: BLE001 - probing optional backends
        continue
else:  # pragma: no cover - pure backend has no import deps and cannot fail here
    raise ImportError("no Ed25519 backend available")


def backend_name() -> str:
    return _BACKEND
