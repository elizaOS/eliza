#include "max_heap_test.h"

#include <stdio.h>
#include <stdlib.h>

#include "../src/max_heap.h"
#include "test_util.h"

static int plain_comparator(void* comparator_data, unsigned a, unsigned b) {
  (void)comparator_data;
  return a - b;
}

void swap(unsigned* a, unsigned* b) {
  unsigned temp = *a;
  *a = *b;
  *b = temp;
}

static void initialize_random_data(unsigned* data, size_t data_size, unsigned seed) {
  srand(seed);
  for (size_t i = 0; i < data_size; i++) {
    data[i] = i;
  }

  for (size_t i = 0; i < data_size; i++) {
    size_t j = rand() % (i + 1);
    swap(&data[i], &data[j]);
  }
}

static void print_data(unsigned* data, size_t data_size) {
  for (size_t i = 0; i < data_size; i++) {
    printf("%d ", data[i]);
  }
}

// use the max heap to sort a list of 10 elements in descending order
static void max_heap_sort_test() {
  PRETTY_PRINT_SUB_TEST_NAME();

  size_t heap_size = 10;
  MaxHeap* heap = max_heap_new(heap_size, plain_comparator, NULL);
  TEST_ASSERT(heap != NULL, "Could not allocate heap!");

  unsigned data[heap_size];
  initialize_random_data(data, heap_size, 666);

  printf("sorting data with heap: ");
  print_data(data, heap_size);
  printf("\n");

  for (size_t i = 0; i < heap_size; i++) {
    TEST_ASSERT(max_heap_insert(heap, data[i]), "Could not insert into heap!");
  }

  TEST_ASSERT_EQ(max_heap_count(heap), heap_size, "Heap wrong size! expected: %ld, got %ld");

  printf("sorted data: ");
  for (size_t i = 0; i < heap_size; i++) {
    unsigned value = 0;
    unsigned expected_value = heap_size - i - 1;
    TEST_ASSERT(max_heap_maximum(heap, &value), "Could not get heap maximum!");
    TEST_ASSERT_EQ(value, expected_value, "Maximum value in heap unexpected! expected: %d, got %d");
    TEST_ASSERT(max_heap_remove_maximum(heap), "Could not pop heap!");
    printf("%d ", value);
  }
  printf("\n");

  TEST_ASSERT_EQ(max_heap_count(heap), (size_t)0, "Heap wrong size! expected: %ld, got %ld");

  max_heap_free(heap);
}

typedef struct {
  unsigned* data;
  size_t data_size;
  size_t data_count;
} BackingStoreData;

static int backing_store_comparator(void* comparator_data, unsigned a, unsigned b) {
  BackingStoreData* backing_store = (BackingStoreData*)comparator_data;
  TEST_ASSERT(a < backing_store->data_size, "Heap tried to compare a value outside the backing store!");
  TEST_ASSERT(b < backing_store->data_size, "Heap tried to compare a value outside the backing store!");
  return backing_store->data[a] - backing_store->data[b];
}

// use the max heap to store the smallest 10 values of a 100 value array
static void max_heap_top_k_test() {
  PRETTY_PRINT_SUB_TEST_NAME();

  size_t heap_size = 10;
  BackingStoreData backing_store;
  backing_store.data = malloc(heap_size * sizeof(unsigned));
  TEST_ASSERT(backing_store.data != NULL, "Could not allocate backing_store->data!");
  backing_store.data_size = heap_size;
  backing_store.data_count = 0;

  MaxHeap* heap = max_heap_new(heap_size, backing_store_comparator, &backing_store);
  TEST_ASSERT(heap != NULL, "Could not allocate heap!");

  size_t data_size = 100;
  unsigned data[data_size];
  initialize_random_data(data, data_size, 666);
  printf("collecting top %ld data in: ", heap_size);
  print_data(data, data_size);
  printf("\n");

  for (size_t i = 0; i < data_size; i++) {
    // if there is still space, just insert
    if (backing_store.data_count < backing_store.data_size) {
      size_t pos = backing_store.data_count++;
      backing_store.data[pos] = data[i];
      max_heap_insert(heap, pos);
      continue;
    }
    // otherwise, we must compare with the maximum and replace if needed
    unsigned maximum;
    TEST_ASSERT(max_heap_maximum(heap, &maximum), "Could not get heap maximum!");
    if (data[i] < backing_store.data[maximum]) {
      backing_store.data[maximum] = data[i];
      max_heap_update_maximum(heap);
    }
  }

  printf("top %ld data: ", heap_size);
  for (size_t i = 0; i < heap_size; i++) {
    unsigned value = 0;
    unsigned expected_value = heap_size - i - 1;
    TEST_ASSERT(max_heap_maximum(heap, &value), "Could not get heap maximum!");
    TEST_ASSERT(value < backing_store.data_size, "Maximum value exceeds backing_store data size!");
    TEST_ASSERT_EQ(backing_store.data[value], expected_value, "Maximum value in heap unexpected! expected: %d, got %d");
    TEST_ASSERT(max_heap_remove_maximum(heap), "Could not pop heap!");
    printf("%d ", backing_store.data[value]);
  }
  printf("\n");

  free(backing_store.data);
  max_heap_free(heap);
}

void max_heap_test() {
  PRETTY_PRINT_TEST_NAME();

  max_heap_sort_test();
  max_heap_top_k_test();
}
