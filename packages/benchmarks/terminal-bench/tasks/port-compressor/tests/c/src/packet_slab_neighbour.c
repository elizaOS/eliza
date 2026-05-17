#include "packet_slab_neighbour.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "lzma_packet_encoder.h"
#include "lzma_state.h"
#include "perplexity_encoder.h"

void packet_slab_neighbour_new(PacketSlabNeighbour* neighbour, PacketSlab* slab, LZMAState init_state) {
  neighbour->init_state = init_state;
  neighbour->slab = slab;
  neighbour->perplexity = 0;
  packet_slab_undo_stack_new(&neighbour->undo_stack);
}

void packet_slab_neighbour_free(PacketSlabNeighbour* neighbour) {
  packet_slab_undo_stack_free(&neighbour->undo_stack);
}

static void encode_to_packet_number(LZMAState* lzma_state, EncoderInterface* enc, LZMAPacket* packets, size_t target) {
  size_t count = 0;
  while (lzma_state->position < lzma_state->data_size) {
    if (count == target) {
      break;
    }
    count++;
    lzma_encode_packet(lzma_state, enc, packets[lzma_state->position]);
  }
}

static void save_packet_at_position(PacketSlabNeighbour* neighbour, LZMAPacket packet, size_t position) {
  PacketSlabUndo undo = {.position = position, .old_packet = packet};
  packet_slab_undo_stack_insert(&neighbour->undo_stack, undo);
}

size_t max(size_t a, size_t b) {
  return a > b ? a : b;
}

size_t min(size_t a, size_t b) {
  return a < b ? a : b;
}

static size_t rand_max_dist(size_t count, size_t num) {
  size_t rnd = rand() % count;
  while (--num != 0) {
    rnd = max(rnd, rand() % count);
  }
  return rnd;
}

static bool pick_random_next_packet_from_top_k(const LZMAState* lzma_state, TopKPacketFinder* packet_finder, LZMAPacket* packets, bool best) {
  LZMAPacket* next_packet = &packets[lzma_state->position];
  top_k_packet_finder_find(packet_finder, lzma_state, packets);
  size_t count = top_k_packet_finder_count(packet_finder);
  if (count == 0) {
    return false;
  }
  size_t choice = rand_max_dist(count, 8);
  if (rand() % 8 == 0 || best) choice = count - 1;
  while (top_k_packet_finder_pop(packet_finder, next_packet)) {
    if (choice-- == 0) {
      return true;
    }
  }
  return true;
}

static bool validate_long_rep_packet(const LZMAState* lzma_state, LZMAPacket packet) {
  assert(packet.type == LONG_REP);
  const uint8_t* rep_start = &lzma_state->data[lzma_state->position - lzma_state->dists[packet.dist] - 1];
  const uint8_t* current = &lzma_state->data[lzma_state->position];
  return memcmp(rep_start, current, packet.len) == 0;
}

static void repair_remaining_packets(PacketSlabNeighbour* neighbour, LZMAState* lzma_state, EncoderInterface* enc, TopKPacketFinder* packet_finder, LZMAPacket* packets) {
  size_t count = 0;
  while (lzma_state->position < lzma_state->data_size) {
    count++;
    LZMAPacket* packet = &packets[lzma_state->position];
    LZMAPacket old_packet = *packet;

    if (packet->type == SHORT_REP || packet->type == LITERAL) {
      if (lzma_state->data[lzma_state->position] == lzma_state->data[lzma_state->position - lzma_state->dists[0] - 1]) {
        if (count < 4) {
          *packet = short_rep_packet();
        }
      } else {
        *packet = literal_packet();
      }
    }
    if (packet->type == LONG_REP) {
      unsigned dist_index = 0;
      while (!validate_long_rep_packet(lzma_state, *packet) && dist_index < 4) {
        packet->dist = dist_index;
        dist_index++;
      }
      if (!validate_long_rep_packet(lzma_state, *packet)) {
        // we don't have to worry about not having a second packet here because there will always be the literal packet
        pick_random_next_packet_from_top_k(lzma_state, packet_finder, packets, rand() % 4 == 0);
      }
    }

    if (!lzma_packet_cmp(&old_packet, packet)) {
      save_packet_at_position(neighbour, old_packet, lzma_state->position);
    }

    lzma_encode_packet(lzma_state, enc, *packet);
  }
}

static bool mutate_next_packet(PacketSlabNeighbour* neighbour, const LZMAState* lzma_state, TopKPacketFinder* packet_finder, LZMAPacket* packets) {
  // try to randomly grow/shrink the next match packet
  LZMAPacket* first_packet = &packets[lzma_state->position];
  if (lzma_state->position + 1 < lzma_state->data_size && rand() % 2 == 0) {
    LZMAPacket* second_packet = &packets[lzma_state->position + 1];
    if ((first_packet->type == LONG_REP || first_packet->type == MATCH) && first_packet->len > 2) {
      save_packet_at_position(neighbour, *first_packet, lzma_state->position);
      save_packet_at_position(neighbour, *second_packet, lzma_state->position + 1);
      *second_packet = *first_packet;
      second_packet->len--;
      *first_packet = literal_packet();
      return true;
    } else if (first_packet->type == LITERAL || first_packet->type == SHORT_REP) {
      if (second_packet->type == MATCH || second_packet->type == LONG_REP) {
        size_t rep_start = lzma_state->position - second_packet->dist;
        if (second_packet->type == LONG_REP) {
          rep_start = lzma_state->position - lzma_state->dists[second_packet->dist];
        }
        if (second_packet->len < 273 && rep_start > 0 && lzma_state->data[lzma_state->position] == lzma_state->data[rep_start - 1]) {
          save_packet_at_position(neighbour, *first_packet, lzma_state->position);
          *first_packet = *second_packet;
          first_packet->len++;
          return true;
        }
      }
    }
  }
  save_packet_at_position(neighbour, packets[lzma_state->position], lzma_state->position);
  if (pick_random_next_packet_from_top_k(lzma_state, packet_finder, packets, false)) {
    return true;
  }
  return false;
}

bool packet_slab_neighbour_generate(PacketSlabNeighbour* neighbour, TopKPacketFinder* packet_finder) {
  LZMAPacket* packets = packet_slab_packets(neighbour->slab);

  LZMAState lzma_state = neighbour->init_state;
  EncoderInterface enc;
  perplexity_encoder_new(&enc, &neighbour->perplexity);

  size_t packet_count = packet_slab_count(neighbour->slab);
  size_t mutation_target = rand() % packet_count;

  encode_to_packet_number(&lzma_state, &enc, packets, mutation_target);
  if (!mutate_next_packet(neighbour, &lzma_state, packet_finder, packets)) {
    return false;
  }
  lzma_encode_packet(&lzma_state, &enc, packets[lzma_state.position]);

  repair_remaining_packets(neighbour, &lzma_state, &enc, packet_finder, packets);
  return true;
}

void packet_slab_neighbour_undo(PacketSlabNeighbour* neighbour) {
  packet_slab_undo_stack_apply(&neighbour->undo_stack, neighbour->slab);
}

size_t packet_slab_neighbour_undo_count(const PacketSlabNeighbour* neighbour) {
  return packet_slab_undo_stack_count(&neighbour->undo_stack);
}
