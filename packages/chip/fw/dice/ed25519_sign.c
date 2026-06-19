/*
 * Ed25519 deterministic key generation + signing, freestanding.
 *
 * Derived from TweetNaCl v20140427 (public domain). The field/group arithmetic
 * is the original constant-time fixed-window ladder; only the sign/keypair path
 * and SHA-512 are kept and renamed for the E1 DICE module. See ed25519_sign.h.
 */

#include "ed25519_sign.h"

typedef int64_t gf[16];

static const gf
    gf0,
    gf1 = {1},
    D2 = {0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0,
          0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406},
    X = {0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c,
         0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169},
    Y = {0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666,
         0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666};

static void *e1_memcpy(void *dst, const void *src, size_t n)
{
    uint8_t *d = (uint8_t *)dst;
    const uint8_t *s = (const uint8_t *)src;
    for (size_t i = 0; i < n; i++) {
        d[i] = s[i];
    }
    return dst;
}

static void *e1_memset(void *dst, int c, size_t n)
{
    uint8_t *d = (uint8_t *)dst;
    for (size_t i = 0; i < n; i++) {
        d[i] = (uint8_t)c;
    }
    return dst;
}

/* ---- SHA-512 (TweetNaCl crypto_hash, FIPS 180-4) ---- */

static uint64_t dl64(const uint8_t *x)
{
    uint64_t u = 0;
    for (int i = 0; i < 8; i++) {
        u = (u << 8) | x[i];
    }
    return u;
}

static void ts64(uint8_t *x, uint64_t u)
{
    for (int i = 7; i >= 0; i--) {
        x[i] = (uint8_t)u;
        u >>= 8;
    }
}

static const uint64_t Ksha[80] = {
    0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL,
    0xe9b5dba58189dbbcULL, 0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL,
    0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL, 0xd807aa98a3030242ULL,
    0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
    0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL,
    0xc19bf174cf692694ULL, 0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL,
    0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL, 0x2de92c6f592b0275ULL,
    0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
    0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL,
    0xbf597fc7beef0ee4ULL, 0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL,
    0x06ca6351e003826fULL, 0x142929670a0e6e70ULL, 0x27b70a8546d22ffcULL,
    0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
    0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL,
    0x92722c851482353bULL, 0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL,
    0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL, 0xd192e819d6ef5218ULL,
    0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
    0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL,
    0x34b0bcb5e19b48a8ULL, 0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL,
    0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL, 0x748f82ee5defb2fcULL,
    0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
    0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL,
    0xc67178f2e372532bULL, 0xca273eceea26619cULL, 0xd186b8c721c0c207ULL,
    0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL, 0x06f067aa72176fbaULL,
    0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
    0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL,
    0x431d67c49c100d4cULL, 0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL,
    0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL};

#define ROTR64(x, c) (((x) >> (c)) | ((x) << (64 - (c))))

static int crypto_hashblocks(uint8_t *x, const uint8_t *m, size_t n)
{
    uint64_t z[8], b[8], a[8], w[16], t;
    for (int i = 0; i < 8; i++) {
        z[i] = a[i] = dl64(x + 8 * i);
    }
    while (n >= 128) {
        for (int i = 0; i < 16; i++) {
            w[i] = dl64(m + 8 * i);
        }
        for (int i = 0; i < 80; i++) {
            for (int j = 0; j < 8; j++) {
                b[j] = a[j];
            }
            t = a[7] + (ROTR64(a[4], 14) ^ ROTR64(a[4], 18) ^ ROTR64(a[4], 41)) +
                ((a[4] & a[5]) ^ (~a[4] & a[6])) + Ksha[i] + w[i % 16];
            b[7] = t + (ROTR64(a[0], 28) ^ ROTR64(a[0], 34) ^ ROTR64(a[0], 39)) +
                   ((a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]));
            b[3] += t;
            for (int j = 0; j < 8; j++) {
                a[(j + 1) % 8] = b[j];
            }
            if (i % 16 == 15) {
                for (int j = 0; j < 16; j++) {
                    w[j] += w[(j + 9) % 16] +
                            (ROTR64(w[(j + 1) % 16], 1) ^
                             ROTR64(w[(j + 1) % 16], 8) ^
                             (w[(j + 1) % 16] >> 7)) +
                            (ROTR64(w[(j + 14) % 16], 19) ^
                             ROTR64(w[(j + 14) % 16], 61) ^
                             (w[(j + 14) % 16] >> 6));
                }
            }
        }
        for (int i = 0; i < 8; i++) {
            a[i] += z[i];
            z[i] = a[i];
        }
        m += 128;
        n -= 128;
    }
    for (int i = 0; i < 8; i++) {
        ts64(x + 8 * i, z[i]);
    }
    return (int)n;
}

static const uint8_t iv[64] = {
    0x6a, 0x09, 0xe6, 0x67, 0xf3, 0xbc, 0xc9, 0x08, 0xbb, 0x67, 0xae,
    0x85, 0x84, 0xca, 0xa7, 0x3b, 0x3c, 0x6e, 0xf3, 0x72, 0xfe, 0x94,
    0xf8, 0x2b, 0xa5, 0x4f, 0xf5, 0x3a, 0x5f, 0x1d, 0x36, 0xf1, 0x51,
    0x0e, 0x52, 0x7f, 0xad, 0xe6, 0x82, 0xd1, 0x9b, 0x05, 0x68, 0x8c,
    0x2b, 0x3e, 0x6c, 0x1f, 0x1f, 0x83, 0xd9, 0xab, 0xfb, 0x41, 0xbd,
    0x6b, 0x5b, 0xe0, 0xcd, 0x19, 0x13, 0x7e, 0x21, 0x79};

/*
 * Incremental SHA-512 so Ed25519 can hash (prefix || message) and
 * (R || A || message) for arbitrary message lengths without an unbounded
 * scratch buffer.
 */
struct sha512_ctx {
    uint8_t state[64];
    uint8_t buf[128];
    size_t buflen;
    uint64_t total;
};

static void sha512_init(struct sha512_ctx *c)
{
    for (int i = 0; i < 64; i++) {
        c->state[i] = iv[i];
    }
    c->buflen = 0;
    c->total = 0;
}

static void sha512_update(struct sha512_ctx *c, const uint8_t *m, size_t n)
{
    c->total += n;
    if (c->buflen != 0) {
        while (n != 0 && c->buflen < 128) {
            c->buf[c->buflen++] = *m++;
            n--;
        }
        if (c->buflen == 128) {
            crypto_hashblocks(c->state, c->buf, 128);
            c->buflen = 0;
        }
    }
    if (n >= 128) {
        size_t blk = n & ~((size_t)127);
        crypto_hashblocks(c->state, m, blk);
        m += blk;
        n -= blk;
    }
    while (n != 0) {
        c->buf[c->buflen++] = *m++;
        n--;
    }
}

static void sha512_final(struct sha512_ctx *c, uint8_t out[64])
{
    uint64_t bits = c->total << 3;
    uint64_t bits_hi = c->total >> 61;
    c->buf[c->buflen++] = 0x80;
    if (c->buflen > 112) {
        while (c->buflen < 128) {
            c->buf[c->buflen++] = 0;
        }
        crypto_hashblocks(c->state, c->buf, 128);
        c->buflen = 0;
    }
    while (c->buflen < 112) {
        c->buf[c->buflen++] = 0;
    }
    ts64(c->buf + 112, bits_hi);
    ts64(c->buf + 120, bits);
    crypto_hashblocks(c->state, c->buf, 128);
    for (int i = 0; i < 64; i++) {
        out[i] = c->state[i];
    }
}

void ed25519_sha512(const uint8_t *m, size_t n, uint8_t out[64])
{
    struct sha512_ctx c;
    sha512_init(&c);
    sha512_update(&c, m, n);
    sha512_final(&c, out);
}

/* ---- Curve25519 field / group arithmetic (Edwards) ---- */

static void set25519(gf r, const gf a)
{
    for (int i = 0; i < 16; i++) {
        r[i] = a[i];
    }
}

static void car25519(gf o)
{
    for (int i = 0; i < 16; i++) {
        o[i] += (1LL << 16);
        int64_t c = o[i] >> 16;
        o[(i + 1) * (i < 15)] += c - 1 + 37 * (c - 1) * (i == 15);
        o[i] -= c << 16;
    }
}

static void sel25519(gf p, gf q, int b)
{
    int64_t t, c = ~(b - 1);
    for (int i = 0; i < 16; i++) {
        t = c & (p[i] ^ q[i]);
        p[i] ^= t;
        q[i] ^= t;
    }
}

static void pack25519(uint8_t *o, const gf n)
{
    int b;
    gf m, t;
    for (int i = 0; i < 16; i++) {
        t[i] = n[i];
    }
    car25519(t);
    car25519(t);
    car25519(t);
    for (int j = 0; j < 2; j++) {
        m[0] = t[0] - 0xffed;
        for (int i = 1; i < 15; i++) {
            m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
            m[i - 1] &= 0xffff;
        }
        m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
        b = (int)((m[15] >> 16) & 1);
        m[14] &= 0xffff;
        sel25519(t, m, 1 - b);
    }
    for (int i = 0; i < 16; i++) {
        o[2 * i] = (uint8_t)(t[i] & 0xff);
        o[2 * i + 1] = (uint8_t)(t[i] >> 8);
    }
}

static uint8_t par25519(const gf a)
{
    uint8_t d[32];
    pack25519(d, a);
    return d[0] & 1;
}

static void A(gf o, const gf a, const gf b)
{
    for (int i = 0; i < 16; i++) {
        o[i] = a[i] + b[i];
    }
}

static void Z(gf o, const gf a, const gf b)
{
    for (int i = 0; i < 16; i++) {
        o[i] = a[i] - b[i];
    }
}

static void M(gf o, const gf a, const gf b)
{
    int64_t t[31];
    for (int i = 0; i < 31; i++) {
        t[i] = 0;
    }
    for (int i = 0; i < 16; i++) {
        for (int j = 0; j < 16; j++) {
            t[i + j] += a[i] * b[j];
        }
    }
    for (int i = 0; i < 15; i++) {
        t[i] += 38 * t[i + 16];
    }
    for (int i = 0; i < 16; i++) {
        o[i] = t[i];
    }
    car25519(o);
    car25519(o);
}

static void S(gf o, const gf a)
{
    M(o, a, a);
}

static void inv25519(gf o, const gf i)
{
    gf c;
    for (int a = 0; a < 16; a++) {
        c[a] = i[a];
    }
    for (int a = 253; a >= 0; a--) {
        S(c, c);
        if (a != 2 && a != 4) {
            M(c, c, i);
        }
    }
    for (int a = 0; a < 16; a++) {
        o[a] = c[a];
    }
}

static void add(gf p[4], gf q[4])
{
    gf a, b, c, d, t, e, f, g, h;
    Z(a, p[1], p[0]);
    Z(t, q[1], q[0]);
    M(a, a, t);
    A(b, p[0], p[1]);
    A(t, q[0], q[1]);
    M(b, b, t);
    M(c, p[3], q[3]);
    M(c, c, D2);
    M(d, p[2], q[2]);
    A(d, d, d);
    Z(e, b, a);
    Z(f, d, c);
    A(g, d, c);
    A(h, b, a);
    M(p[0], e, f);
    M(p[1], h, g);
    M(p[2], g, f);
    M(p[3], e, h);
}

static void cswap(gf p[4], gf q[4], uint8_t b)
{
    for (int i = 0; i < 4; i++) {
        sel25519(p[i], q[i], b);
    }
}

static void pack(uint8_t *r, gf p[4])
{
    gf tx, ty, zi;
    inv25519(zi, p[2]);
    M(tx, p[0], zi);
    M(ty, p[1], zi);
    pack25519(r, ty);
    r[31] ^= par25519(tx) << 7;
}

static void scalarmult(gf p[4], gf q[4], const uint8_t *s)
{
    set25519(p[0], gf0);
    set25519(p[1], gf1);
    set25519(p[2], gf1);
    set25519(p[3], gf0);
    for (int i = 255; i >= 0; --i) {
        uint8_t b = (uint8_t)((s[i / 8] >> (i & 7)) & 1);
        cswap(p, q, b);
        add(q, p);
        add(p, p);
        cswap(p, q, b);
    }
}

static void scalarbase(gf p[4], const uint8_t *s)
{
    gf q[4];
    set25519(q[0], X);
    set25519(q[1], Y);
    set25519(q[2], gf1);
    M(q[3], X, Y);
    scalarmult(p, q, s);
}

static const uint64_t L[32] = {
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7,
    0xa2, 0xde, 0xf9, 0xde, 0x14, 0,    0,    0,    0,    0,    0,
    0,    0,    0,    0,    0,    0,    0,    0,    0,    0x10};

static void modL(uint8_t *r, int64_t x[64])
{
    int64_t carry;
    for (int i = 63; i >= 32; --i) {
        carry = 0;
        int j;
        for (j = i - 32; j < i - 12; ++j) {
            x[j] += carry - 16 * x[i] * (int64_t)L[j - (i - 32)];
            carry = (x[j] + 128) >> 8;
            x[j] -= carry << 8;
        }
        x[j] += carry;
        x[i] = 0;
    }
    carry = 0;
    for (int j = 0; j < 32; j++) {
        x[j] += carry - (x[31] >> 4) * (int64_t)L[j];
        carry = x[j] >> 8;
        x[j] &= 255;
    }
    for (int j = 0; j < 32; j++) {
        x[j] -= carry * (int64_t)L[j];
    }
    for (int i = 0; i < 32; i++) {
        x[i + 1] += x[i] >> 8;
        r[i] = (uint8_t)(x[i] & 255);
    }
}

static void reduce(uint8_t *r)
{
    int64_t x[64];
    for (int i = 0; i < 64; i++) {
        x[i] = (int64_t)(uint64_t)r[i];
    }
    for (int i = 0; i < 64; i++) {
        r[i] = 0;
    }
    modL(r, x);
}

/* ---- Public API ---- */

void ed25519_keypair_from_seed(uint8_t pk[32], uint8_t sk[64],
                               const uint8_t seed[32])
{
    uint8_t d[64];
    gf p[4];

    e1_memcpy(sk, seed, 32);
    ed25519_sha512(sk, 32, d);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;

    scalarbase(p, d);
    pack(pk, p);

    e1_memcpy(sk + 32, pk, 32);
    e1_memset(d, 0, sizeof d);
}

void ed25519_sign(uint8_t sig[64], const uint8_t *m, size_t n,
                  const uint8_t sk[64])
{
    uint8_t d[64], h[64], r[64];
    int64_t x[64];
    struct sha512_ctx hc;
    gf p[4];

    /* sk = seed(32) || pubkey(32). Expand the seed exactly as keygen does;
     * d[0..32) is the clamped scalar a, d[32..64) is the nonce prefix. */
    ed25519_sha512(sk, 32, d);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;

    /* Deterministic nonce r = SHA-512(prefix || M) mod L. */
    sha512_init(&hc);
    sha512_update(&hc, d + 32, 32);
    sha512_update(&hc, m, n);
    sha512_final(&hc, r);
    reduce(r);

    scalarbase(p, r);
    pack(sig, p); /* R = [r]B into sig[0..32) */

    /* Challenge k = SHA-512(R || A || M) mod L. */
    sha512_init(&hc);
    sha512_update(&hc, sig, 32);
    sha512_update(&hc, sk + 32, 32);
    sha512_update(&hc, m, n);
    sha512_final(&hc, h);
    reduce(h);

    /* S = (r + k*a) mod L into sig[32..64). */
    for (int i = 0; i < 64; i++) {
        x[i] = 0;
    }
    for (int i = 0; i < 32; i++) {
        x[i] = (int64_t)(uint64_t)r[i];
    }
    for (int i = 0; i < 32; i++) {
        for (int j = 0; j < 32; j++) {
            x[i + j] += (int64_t)h[i] * (int64_t)d[j];
        }
    }
    modL(sig + 32, x);

    e1_memset(d, 0, sizeof d);
}
