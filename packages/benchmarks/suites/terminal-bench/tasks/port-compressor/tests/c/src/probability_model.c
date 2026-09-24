#include "probability_model.h"

#define NUM_MOVE_BITS 5

void encode_bit(bool bit, Prob* prob, EncoderInterface* enc) {
  (*enc->encode_bit)(enc, bit, *prob);
  unsigned v = *prob;
  if (bit) {
    v -= v >> NUM_MOVE_BITS;
  } else {
    v += ((1 << NUM_BIT_MODEL_TOTAL_BITS) - v) >> NUM_MOVE_BITS;
  }
  *prob = (Prob)v;
}

void encode_direct_bits(unsigned bits, size_t num_bits, EncoderInterface* enc) {
  (*enc->encode_direct_bits)(enc, bits, num_bits);
}

void encode_bit_tree(unsigned bits, Prob* probs, size_t num_bits, EncoderInterface* enc) {
  unsigned m = 1;
  for (unsigned bit_index = num_bits; bit_index != 0;) {
    bit_index--;
    int bit = (bits >> bit_index) & 1;
    encode_bit(bit, &probs[m], enc);
    m = (m << 1) | bit;
  }
}

void encode_bit_tree_reverse(unsigned bits, Prob* probs, size_t num_bits, EncoderInterface* enc) {
  unsigned m = 1;
  for (unsigned i = 0; i < num_bits; i++) {
    int bit = bits & 1;
    encode_bit(bit, &probs[m], enc);
    m = (m << 1) | bit;
    bits >>= 1;
  }
}
