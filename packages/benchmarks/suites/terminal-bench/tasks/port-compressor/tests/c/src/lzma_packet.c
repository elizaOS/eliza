#include "lzma_packet.h"

bool lzma_packet_cmp(const LZMAPacket* a, const LZMAPacket* b) {
  return a->type == b->type && a->len == b->len && a->dist == b->dist;
}

LZMAPacket literal_packet() {
  LZMAPacket packet = {
      .type = LITERAL,
      .dist = 0,
      .len = 1};
  return packet;
}

LZMAPacket match_packet(unsigned dist, unsigned len) {
  LZMAPacket packet = {
      .type = MATCH,
      .dist = dist,
      .len = len};
  return packet;
}

LZMAPacket short_rep_packet() {
  LZMAPacket packet = {
      .type = SHORT_REP,
      .dist = 0,
      .len = 1};
  return packet;
}

LZMAPacket long_rep_packet(unsigned dist_index, unsigned len) {
  LZMAPacket packet = {
      .type = LONG_REP,
      .dist = dist_index,
      .len = len};
  return packet;
}
