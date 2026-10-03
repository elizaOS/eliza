#include "packet_slab_undo_stack_test.h"

#include "../src/lzma_packet.h"
#include "../src/packet_slab.h"
#include "../src/packet_slab_undo_stack.h"
#include "test_util.h"

#define SLAB_SIZE 1024

static void packet_slab_undo_stack_test_apply() {
  PRETTY_PRINT_SUB_TEST_NAME();

  fprintf(stderr, "allocating PacketSlab of size %ld\n", (size_t)SLAB_SIZE);
  PacketSlab* slab = packet_slab_new(SLAB_SIZE);

  TEST_ASSERT(slab != NULL, "Could not allocate slab!");

  PacketSlabUndoStack undo_stack;
  packet_slab_undo_stack_new(&undo_stack);

  fprintf(stderr, "changing all packets to shortreps...\n");
  LZMAPacket* packets = packet_slab_packets(slab);
  for (size_t i = 0; i < SLAB_SIZE; i++) {
    PacketSlabUndo undo = {.position = i, .old_packet = packets[i]};
    packets[i] = short_rep_packet();
    packet_slab_undo_stack_insert(&undo_stack, undo);
  }
  fprintf(stderr, "undoing shortreps...\n");
  packet_slab_undo_stack_apply(&undo_stack, slab);
  for (size_t i = 0; i < SLAB_SIZE; i++) {
    TEST_ASSERT_EQ(packets[i].type, LITERAL, "Packet edit was not undone! expected: %d, got %d");
  }
  TEST_ASSERT_EQ(undo_stack.count, 0u, "Undo_stack count non-zero! expected: %d, got: %ld");

  fprintf(stderr, "freeing memory...\n");
  packet_slab_undo_stack_free(&undo_stack);
  packet_slab_free(slab);
}

static void packet_slab_undo_stack_test_free() {
  PRETTY_PRINT_SUB_TEST_NAME();

  fprintf(stderr, "allocating PacketSlab of size %ld\n", (size_t)SLAB_SIZE);
  PacketSlab* slab = packet_slab_new(SLAB_SIZE);

  TEST_ASSERT(slab != NULL, "Could not allocate slab!");

  PacketSlabUndoStack undo_stack;
  packet_slab_undo_stack_new(&undo_stack);

  fprintf(stderr, "changing all packets to shortreps...\n");
  LZMAPacket* packets = packet_slab_packets(slab);
  for (size_t i = 0; i < SLAB_SIZE; i++) {
    PacketSlabUndo undo = {.position = i, .old_packet = packets[i]};
    packets[i] = short_rep_packet();
    packet_slab_undo_stack_insert(&undo_stack, undo);
  }
  fprintf(stderr, "not undoing shortreps...\n");
  for (size_t i = 0; i < SLAB_SIZE; i++) {
    TEST_ASSERT_EQ(packets[i].type, SHORT_REP, "Packet edit was not applied! expected: %d, got %d");
  }

  fprintf(stderr, "freeing memory...\n");
  packet_slab_undo_stack_free(&undo_stack);
  packet_slab_free(slab);
}

void packet_slab_undo_stack_test() {
  PRETTY_PRINT_TEST_NAME();

  packet_slab_undo_stack_test_apply();
  packet_slab_undo_stack_test_free();
}
