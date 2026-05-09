/*
 * Internal block-format invariants. Kept separate from the public header
 * so the public API stays free of the static-assert noise.
 */
#ifndef QJL_QJL_BLOCK_H
#define QJL_QJL_BLOCK_H

#include "qjl/qjl.h"

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(qjl_block_qjl1_256) == 34,
               "block_qjl1_256 must be 32 bytes signs + 2 bytes bf16 norm");
_Static_assert(QJL_PROJECTION_DIM == 256, "canonical paper default");
_Static_assert(QJL_HEAD_DIM == 128, "canonical paper default");
_Static_assert(QJL_PACKED_BYTES == 32, "256 bits / 8 = 32 bytes");
#endif

#endif /* QJL_QJL_BLOCK_H */
