#include "max_heap.h"

#include <stdio.h>
#include <stdlib.h>

#define PARENT_INDEX(x) ((x - 1) / 2)
#define LEFT_INDEX(x) (x * 2 + 1)
#define RIGHT_INDEX(x) (x * 2 + 2)

struct MaxHeap_struct {
  unsigned* store;
  size_t store_size;
  size_t count;
  MaxHeapComparator comparator;
  void* comparator_data;
};

MaxHeap* max_heap_new(size_t size, MaxHeapComparator comparator, void* comparator_data) {
  MaxHeap* heap = malloc(sizeof(MaxHeap));
  if (heap == NULL) {
    fprintf(stderr, "Could not allocate memory for MaxHeap.\n");
    return NULL;
  }
  heap->store = malloc(sizeof(unsigned) * size);
  if (heap->store == NULL) {
    fprintf(stderr, "Could not allocate memory for MaxHeap store.\n");
    free(heap);
    return NULL;
  }
  heap->store_size = size;
  heap->count = 0;
  heap->comparator = comparator;
  heap->comparator_data = comparator_data;
  return heap;
}

void max_heap_free(MaxHeap* heap) {
  if (heap == NULL) {
    return;
  }
  free(heap->store);
  free(heap);
}

size_t max_heap_count(const MaxHeap* heap) {
  return heap->count;
}

void max_heap_clear(MaxHeap* heap) {
  heap->count = 0;
}

static void swap(unsigned* a, unsigned* b) {
  unsigned temp = *a;
  *a = *b;
  *b = temp;
}

static bool max_heap_parent(MaxHeap* heap, size_t index, size_t* parent) {
  (void)heap;
  *parent = (index - 1) / 2;
  return index > 0;
}

static bool max_heap_left_child(MaxHeap* heap, size_t index, size_t* left_child) {
  *left_child = index * 2 + 1;
  return *left_child < heap->count;
}

static bool max_heap_right_child(MaxHeap* heap, size_t index, size_t* right_child) {
  *right_child = index * 2 + 2;
  return *right_child < heap->count;
}

static void max_heap_bubble_down(MaxHeap* heap, size_t parent) {
  MaxHeapComparator cmp = heap->comparator;
  void* cmp_dat = heap->comparator_data;

  size_t left_child;
  size_t right_child;
  // this could be `while(max_heap_has_children)` but this is equivalent to having a left child
  while (max_heap_left_child(heap, parent, &left_child)) {
    size_t largest_child = left_child;
    if (max_heap_right_child(heap, parent, &right_child)) {
      if ((*cmp)(cmp_dat, heap->store[right_child], heap->store[left_child]) > 0) {
        largest_child = right_child;
      }
    }

    if ((*cmp)(cmp_dat, heap->store[largest_child], heap->store[parent]) > 0) {
      swap(&heap->store[largest_child], &heap->store[parent]);
      parent = largest_child;
    } else {
      break;
    }
  }
}

static void max_heap_bubble_up(MaxHeap* heap, size_t node) {
  MaxHeapComparator cmp = heap->comparator;
  void* cmp_dat = heap->comparator_data;

  size_t parent;
  while (max_heap_parent(heap, node, &parent)) {
    if ((*cmp)(cmp_dat, heap->store[node], heap->store[parent]) > 0) {
      swap(&heap->store[node], &heap->store[parent]);
      node = parent;
    } else {
      break;
    }
  }
}

bool max_heap_insert(MaxHeap* heap, unsigned value) {
  if (heap->count == heap->store_size) {
    return false;
  }

  size_t new_node = heap->count++;
  heap->store[new_node] = value;
  max_heap_bubble_up(heap, new_node);

  return true;
}

bool max_heap_maximum(MaxHeap* heap, unsigned* value) {
  if (heap->count == 0) {
    return false;
  }

  *value = heap->store[0];
  return true;
}

bool max_heap_remove_maximum(MaxHeap* heap) {
  if (heap->count == 0) {
    return false;
  }

  heap->store[0] = heap->store[--heap->count];
  max_heap_bubble_down(heap, 0);

  return true;
}

bool max_heap_update_maximum(MaxHeap* heap) {
  if (heap->count == 0) {
    return false;
  }

  max_heap_bubble_down(heap, 0);

  return true;
}
