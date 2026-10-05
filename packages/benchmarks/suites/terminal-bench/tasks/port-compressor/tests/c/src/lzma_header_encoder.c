#include "lzma_header_encoder.h"

#include <endian.h>
#include <unistd.h>

static uint8_t lzma_encode_header_properties(const LZMAState* lzma_state) {
  const LZMAProperties* p = &lzma_state->properties;
  return ((p->pb * 5 + p->lp) * 9 + p->lc);
}

void lzma_encode_header(const LZMAState* lzma_state, OutputInterface* output) {
  uint8_t props = lzma_encode_header_properties(lzma_state);
  (*output->write)(output, &props, sizeof(uint8_t));

  uint32_t dictsize = htole32(0x400000);  // todo: peg this to data size
  (*output->write)(output, &dictsize, sizeof(uint32_t));

  uint64_t outsize = htole32(lzma_state->data_size);
  (*output->write)(output, &outsize, sizeof(uint64_t));
}
