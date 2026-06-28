/* Boot measurement chain + keymgr-advance contract. See measure.h. */

#include "measure.h"

void boot_measure_init(struct boot_measure *m)
{
    for (unsigned i = 0; i < SHA256_DIGEST_LEN; i++) {
        m->reg[i] = 0;
    }
    m->stage = KEYMGR_STAGE_RESET;
    m->extend_count = 0;
}

void boot_measure_extend(struct boot_measure *m,
                         const uint8_t stage_hash[SHA256_DIGEST_LEN])
{
    struct sha256_ctx ctx;
    uint8_t next[SHA256_DIGEST_LEN];

    sha256_init(&ctx);
    sha256_update(&ctx, m->reg, SHA256_DIGEST_LEN);
    sha256_update(&ctx, stage_hash, SHA256_DIGEST_LEN);
    sha256_final(&ctx, next);

    for (unsigned i = 0; i < SHA256_DIGEST_LEN; i++) {
        m->reg[i] = next[i];
    }
    m->extend_count++;
}

enum keymgr_stage keymgr_advance(struct boot_measure *m,
                                 enum keymgr_stage next_stage,
                                 const uint8_t stage_hash[SHA256_DIGEST_LEN])
{
    /* The ladder advances strictly one stage at a time; no skips. */
    if ((unsigned)next_stage != (unsigned)m->stage + 1u) {
        return m->stage;
    }
    boot_measure_extend(m, stage_hash);
    m->stage = next_stage;
    return m->stage;
}

void boot_measure_export(const struct boot_measure *m,
                         uint8_t out[SHA256_DIGEST_LEN])
{
    for (unsigned i = 0; i < SHA256_DIGEST_LEN; i++) {
        out[i] = m->reg[i];
    }
}
