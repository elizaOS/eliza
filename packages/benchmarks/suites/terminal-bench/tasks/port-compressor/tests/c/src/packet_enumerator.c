#include "packet_enumerator.h"

#include <assert.h>
#include <stdlib.h>

#include "substring_enumerator.h"

#define MIN_SUBSTRING 2
#define MAX_SUBSTRING 273

struct PacketEnumerator_struct {
  const uint8_t* data;
  size_t data_size;

  SubstringEnumerator* substring_enumerator;
};

size_t packet_enumerator_memory_usage(size_t data_size) {
  return sizeof(PacketEnumerator) + substring_enumerator_memory_usage(data_size);
}

PacketEnumerator* packet_enumerator_new(const uint8_t* data, size_t data_size) {
  PacketEnumerator* enumerator = malloc(sizeof(PacketEnumerator));
  enumerator->data = data;
  enumerator->data_size = data_size;
  enumerator->substring_enumerator = substring_enumerator_new(data, data_size, MIN_SUBSTRING, MAX_SUBSTRING);
  return enumerator;
}

void packet_enumerator_free(PacketEnumerator* enumerator) {
  substring_enumerator_free(enumerator->substring_enumerator);
  free(enumerator);
}

typedef struct {
  const LZMAState* lzma_state;
  PacketEnumeratorCallback callback;
  void* user_data;
} PacketEnumeratorSubstringCallbackData;

static void packet_enumerator_substring_callback(void* user_data, size_t offset, size_t length) {
  PacketEnumeratorSubstringCallbackData* data = (PacketEnumeratorSubstringCallbackData*)user_data;
  const LZMAState* lzma_state = data->lzma_state;
  PacketEnumeratorCallback callback = data->callback;
  void* callback_user_data = data->user_data;

  unsigned dist = lzma_state->position - offset - 1;
  (*callback)(callback_user_data, lzma_state, match_packet(dist, length));
  for (int i = 0; i < 4; i++) {
    if (dist == lzma_state->dists[i]) {
      (*callback)(callback_user_data, lzma_state, long_rep_packet(i, length));
    }
  }
}

void packet_enumerator_for_each(const PacketEnumerator* enumerator, const LZMAState* lzma_state, PacketEnumeratorCallback callback, void* user_data) {
  assert(enumerator->data == lzma_state->data);

  (*callback)(user_data, lzma_state, literal_packet());
  if (lzma_state->position > 0) {
    size_t rep0_position = lzma_state->position - lzma_state->dists[0] - 1;
    if (enumerator->data[lzma_state->position] == enumerator->data[rep0_position]) {
      (*callback)(user_data, lzma_state, short_rep_packet());
    }
  }

  PacketEnumeratorSubstringCallbackData data = {
      .lzma_state = lzma_state,
      .callback = callback,
      .user_data = user_data};
  substring_enumerator_for_each(enumerator->substring_enumerator, lzma_state->position, packet_enumerator_substring_callback, &data);
}
