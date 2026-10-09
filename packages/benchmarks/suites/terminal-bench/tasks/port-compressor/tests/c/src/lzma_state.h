#pragma once
#include <stddef.h>

#include "probability.h"

// the LZMA state struct defines the LZMA compression algorithm in progress. It has a pointer to the data it is compressing, the size of that data, and the LZMA 'properties'. These parameters are constant throughout the lifetime of the class. It also stores its position in the data, the current condition of the probability model, the lzma 'state', and the stack of most recent match distances. These parameters change as the LZMAState is used to compress data.

#define NUM_POS_BITS_MAX 4
#define LOW_CODER_BITS 3
#define LOW_CODER_SYMBOLS (1 << LOW_CODER_BITS)
#define MID_CODER_BITS 3
#define MID_CODER_SYMBOLS (1 << MID_CODER_BITS)
#define HIGH_CODER_BITS 8
#define HIGH_CODER_SYMBOLS (1 << HIGH_CODER_BITS)

typedef struct {
  Prob choice_1;
  Prob choice_2;

  Prob low_coder[1 << NUM_POS_BITS_MAX][1 << LOW_CODER_BITS];
  Prob mid_coder[1 << NUM_POS_BITS_MAX][1 << MID_CODER_BITS];
  Prob high_coder[1 << HIGH_CODER_BITS];
} LengthProbabilityModel;

#define NUM_LEN_TO_POS_STATES 4
#define POS_SLOT_BITS 6
#define ALIGN_BITS 4
#define END_POS_MODEL_INDEX 14
#define NUM_FULL_DISTANCES (1 << (END_POS_MODEL_INDEX >> 1))

typedef struct {
  Prob pos_slot_coder[NUM_LEN_TO_POS_STATES][1 << POS_SLOT_BITS];
  Prob align_coder[1 << ALIGN_BITS];
  Prob pos_coder[1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX];
} DistanceProbabilityModel;

#define NUM_STATES 12

typedef struct {
  Prob is_match[NUM_STATES << NUM_POS_BITS_MAX];
  Prob is_rep[NUM_STATES];
  Prob is_rep_g0[NUM_STATES];
  Prob is_rep_g1[NUM_STATES];
  Prob is_rep_g2[NUM_STATES];
  Prob is_rep0_long[NUM_STATES << NUM_POS_BITS_MAX];
} ContextStateProbabilityModel;

#define LIT_PROBS_SIZE 0x300

typedef struct {
  Prob lit[LIT_PROBS_SIZE];
  LengthProbabilityModel len;
  LengthProbabilityModel rep_len;
  DistanceProbabilityModel dist;
  ContextStateProbabilityModel ctx_state;
} LZMAProbabilityModel;

typedef struct {
  uint8_t lc;
  uint8_t lp;
  uint8_t pb;
} LZMAProperties;

typedef struct {
  const uint8_t* data;
  size_t data_size;
  LZMAProperties properties;

  uint8_t ctx_state;

  uint32_t dists[4];
  LZMAProbabilityModel probs;
  size_t position;
} LZMAState;

void lzma_state_init(LZMAState* lzma_state, const uint8_t* data, size_t data_size, LZMAProperties properties);
void lzma_state_update_ctx_state(LZMAState* lzma_state, unsigned packet_type);

void lzma_state_push_distance(LZMAState* lzma_state, uint32_t dist);
void lzma_state_promote_distance_at(LZMAState* lzma_state, unsigned dist_index);
