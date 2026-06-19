#include "range_encoder.h"

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

// Most of this code is lifted directly from example LZMA encoders. I haven't yet figured out how exactly it works practically, I just know the theory.

#define TOP_MASK 0xFF000000

typedef struct {
  OutputInterface* output;
  uint64_t low;
  uint32_t range;
  uint8_t cache;
  uint64_t cache_size;
} RangeEncoderData;

static void range_encoder_shift_low(EncoderInterface* enc) {
  RangeEncoderData* data = (RangeEncoderData*)enc->private_data;
  OutputInterface* output = data->output;

  uint32_t high_bytes = data->low >> 32;
  uint32_t low_bytes = data->low & 0xFFFFFFFF;
  if (low_bytes < TOP_MASK || high_bytes != 0) {
    uint8_t temp = data->cache;
    do {
      uint8_t out_byte = temp + (high_bytes & 0xFF);
      if (!(*output->write)(output, &out_byte, 1)) {
        fprintf(stderr, "could not write: %02x\n", out_byte);
      }
      temp = 0xFF;
    } while (--data->cache_size != 0);
    data->cache = (data->low >> 24) & 0xFF;
  }
  data->cache_size++;
  data->low = low_bytes << 8;
}

static void range_encoder_flush_data(EncoderInterface* enc) {
  for (int i = 0; i < 5; i++) {
    range_encoder_shift_low(enc);
  }
}

static void range_encoder_encode_bit(EncoderInterface* enc, bool bit, Prob prob) {
  RangeEncoderData* data = (RangeEncoderData*)enc->private_data;
  // todo: make this a debug option..?
  //  fprintf(stderr, "bit: %d %d %u\n", bit, prob, data->range);

  uint32_t new_bound = (data->range >> NUM_BIT_MODEL_TOTAL_BITS) * prob;
  if (bit) {
    data->low += new_bound;
    data->range -= new_bound;
  } else {
    data->range = new_bound;
  }
  while ((data->range & TOP_MASK) == 0) {
    data->range <<= 8;
    range_encoder_shift_low(enc);
  }
}

static void range_encoder_encode_direct_bits(EncoderInterface* enc, unsigned bits, unsigned num_bits) {
  RangeEncoderData* data = (RangeEncoderData*)enc->private_data;
  do {
    bool bit = bits & (1 << (num_bits - 1));
    // fprintf(stderr, "bit: %d direct %u\n", bit, data->range);
    data->range >>= 1;
    if (bit) {
      data->low += data->range;
    }
    if ((data->range & TOP_MASK) == 0) {
      data->range <<= 8;
      range_encoder_shift_low(enc);
    }
  } while (--num_bits);
}

void range_encoder_new(EncoderInterface* enc, OutputInterface* output) {
  RangeEncoderData* data = malloc(sizeof(RangeEncoderData));
  data->output = output;
  data->low = 0;
  data->range = 0xFFFFFFFF;
  data->cache = 0;
  data->cache_size = 1;

  enc->encode_bit = range_encoder_encode_bit;
  enc->encode_direct_bits = range_encoder_encode_direct_bits;
  enc->private_data = (void*)data;
}

void range_encoder_free(EncoderInterface* enc) {
  range_encoder_flush_data(enc);
  free(enc->private_data);
}
