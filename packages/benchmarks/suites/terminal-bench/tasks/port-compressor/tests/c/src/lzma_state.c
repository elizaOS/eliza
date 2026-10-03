#include "lzma_state.h"

#include <assert.h>
#include <string.h>

#include "lzma_packet.h"

static void lzma_state_init_probs(LZMAProbabilityModel* probs) {
  // this is probably undefined behaviour but whatever...
  int num_probs = sizeof(LZMAProbabilityModel) / sizeof(Prob);
  Prob* prob_array = (Prob*)probs;
  for (int i = 0; i < num_probs; i++) {
    prob_array[i] = PROB_INIT_VAL;
  }
}

void lzma_state_init(LZMAState* lzma_state, const uint8_t* data, size_t data_size, LZMAProperties properties) {
  lzma_state->data = data;
  lzma_state->data_size = data_size;
  lzma_state->properties = properties;

  lzma_state->ctx_state = 0;
  memset(lzma_state->dists, 0, sizeof(lzma_state->dists));
  lzma_state_init_probs(&lzma_state->probs);

  lzma_state->position = 0;
}

void lzma_state_update_ctx_state(LZMAState* lzma_state, unsigned packet_type) {
  uint8_t ctx_state = lzma_state->ctx_state;
  switch (packet_type) {
    case LITERAL:
      if (ctx_state < 4) {
        ctx_state = 0;
      } else if (ctx_state < 10) {
        ctx_state -= 3;
      } else {
        ctx_state -= 6;
      }
      break;
    case MATCH:
      ctx_state = ctx_state < 7 ? 7 : 10;
      break;
    case SHORT_REP:
      ctx_state = ctx_state < 7 ? 9 : 11;
      break;
    case LONG_REP:
      ctx_state = ctx_state < 7 ? 8 : 11;
      break;
    case INVALID:
    default:
      assert(false);
      break;
  }
  lzma_state->ctx_state = ctx_state;
}

void lzma_state_push_distance(LZMAState* lzma_state, uint32_t dist) {
  lzma_state->dists[3] = lzma_state->dists[2];
  lzma_state->dists[2] = lzma_state->dists[1];
  lzma_state->dists[1] = lzma_state->dists[0];
  lzma_state->dists[0] = dist;
}

void lzma_state_promote_distance_at(LZMAState* lzma_state, unsigned dist_index) {
  assert(dist_index < 4);
  uint32_t dist = lzma_state->dists[dist_index];
  if (dist_index > 2) {
    lzma_state->dists[3] = lzma_state->dists[2];
  }
  if (dist_index > 1) {
    lzma_state->dists[2] = lzma_state->dists[1];
  }
  if (dist_index > 0) {
    lzma_state->dists[1] = lzma_state->dists[0];
  }
  lzma_state->dists[0] = dist;
}
