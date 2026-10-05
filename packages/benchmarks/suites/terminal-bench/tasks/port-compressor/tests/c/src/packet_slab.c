#include "packet_slab.h"

#include <stdlib.h>

#include "memory_mapper.h"

struct PacketSlab_struct {
  size_t data_size;
  LZMAPacket* packets;
};

size_t packet_slab_memory_usage(size_t data_size) {
  return sizeof(LZMAPacket) * data_size + sizeof(PacketSlab);
}

PacketSlab* packet_slab_new(size_t data_size) {
  PacketSlab* slab = malloc(sizeof(PacketSlab));
  if (slab == NULL) {
    return NULL;
  }
  slab->data_size = data_size;

  uint8_t* packets;
  if (map_anonymous(sizeof(LZMAPacket) * data_size, &packets)) {
    free(slab);
    return NULL;
  }
  slab->packets = (LZMAPacket*)packets;

  for (size_t i = 0; i < data_size; i++) {
    slab->packets[i] = literal_packet();
  }

  return slab;
}

void packet_slab_free(PacketSlab* slab) {
  unmap((uint8_t*)slab->packets, sizeof(LZMAPacket) * slab->data_size);
  free(slab);
}

size_t packet_slab_size(const PacketSlab* slab) {
  return slab->data_size;
}

size_t packet_slab_count(const PacketSlab* slab) {
  size_t position = 0;
  size_t count = 0;
  while (position < slab->data_size) {
    count++;
    position += slab->packets[position].len;
  }
  return count;
}

LZMAPacket* packet_slab_packets(PacketSlab* slab) {
  return slab->packets;
}
