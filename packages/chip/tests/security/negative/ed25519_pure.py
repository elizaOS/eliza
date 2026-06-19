"""Pure-Python Ed25519 (RFC 8032) reference, no third-party dependencies.

Adapted from the RFC 8032 §6 reference implementation (public domain). Used by
the W7 harness only when neither `cryptography` nor `nacl` is importable, so the
negative-evidence transcripts can be regenerated on a bare interpreter. This is
a TEST-VECTOR generator, not constant-time and not for production use; the
production verifier is fw/boot-rom/secure/ed25519_ct.c.
"""

from __future__ import annotations

import hashlib

_b = 256
_q = 2**255 - 19
_l = 2**252 + 27742317777372353535851937790883648493


def _h(m: bytes) -> bytes:
    return hashlib.sha512(m).digest()


def _inv(x: int) -> int:
    return pow(x, _q - 2, _q)


_d = (-121665 * _inv(121666)) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(_d * y * y + 1)
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x


_By = (4 * _inv(5)) % _q
_Bx = _xrecover(_By)
_B = (_Bx % _q, _By % _q, 1, (_Bx * _By) % _q)


def _edwards_add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _q
    b = (y1 + x1) * (y2 + x2) % _q
    c = t1 * 2 * _d * t2 % _q
    dd = z1 * 2 * z2 % _q
    e = b - a
    f = dd - c
    g = dd + c
    hh = b + a
    x3 = e * f
    y3 = g * hh
    t3 = e * hh
    z3 = f * g
    return (x3 % _q, y3 % _q, z3 % _q, t3 % _q)


def _scalarmult(p, e: int):
    if e == 0:
        return (0, 1, 1, 0)
    q = _scalarmult(p, e // 2)
    q = _edwards_add(q, q)
    if e & 1:
        q = _edwards_add(q, p)
    return q


def _encodeint(y: int) -> bytes:
    return y.to_bytes(_b // 8, "little")


def _encodepoint(p) -> bytes:
    x, y, z, _t = p
    zi = _inv(z)
    x = (x * zi) % _q
    y = (y * zi) % _q
    bits = y | ((x & 1) << (_b - 1))
    return bits.to_bytes(_b // 8, "little")


def _bit(h: bytes, i: int) -> int:
    return (h[i // 8] >> (i % 8)) & 1


def public_key(seed: bytes) -> bytes:
    h = _h(seed)
    a = 2 ** (_b - 2) + sum(2**i * _bit(h, i) for i in range(3, _b - 2))
    big_a = _scalarmult(_B, a)
    return _encodepoint(big_a)


def _hint(m: bytes) -> int:
    return int.from_bytes(_h(m), "little")


def sign(seed: bytes, pub: bytes, msg: bytes) -> bytes:
    h = _h(seed)
    a = 2 ** (_b - 2) + sum(2**i * _bit(h, i) for i in range(3, _b - 2))
    r = _hint(h[_b // 8 : _b // 4] + msg)
    big_r = _scalarmult(_B, r)
    enc_r = _encodepoint(big_r)
    s = (r + _hint(enc_r + pub + msg) * a) % _l
    return enc_r + _encodeint(s)


def _decodepoint(s: bytes):
    y = int.from_bytes(s, "little") & ((1 << (_b - 1)) - 1)
    x = _xrecover(y)
    if (x & 1) != _bit(s, _b - 1):
        x = _q - x
    p = (x, y, 1, (x * y) % _q)
    if not _isoncurve(p):
        raise ValueError("decoding point not on curve")
    return p


def _isoncurve(p) -> bool:
    x, y, z, t = p
    return (
        z % _q != 0
        and (x * y) % _q == (z * t) % _q
        and (y * y - x * x - z * z - _d * t * t) % _q == 0
    )


def verify(pub: bytes, msg: bytes, sig: bytes) -> bool:
    if len(sig) != _b // 4 or len(pub) != _b // 8:
        return False
    try:
        big_r = _decodepoint(sig[: _b // 8])
        big_a = _decodepoint(pub)
    except (ValueError, Exception):  # noqa: BLE001
        return False
    s = int.from_bytes(sig[_b // 8 : _b // 4], "little")
    if s >= _l:
        return False
    h = _hint(_encodepoint(big_r) + pub + msg)
    left = _scalarmult(_B, s)
    right = _edwards_add(big_r, _scalarmult(big_a, h))
    return _encodepoint(left) == _encodepoint(right)
