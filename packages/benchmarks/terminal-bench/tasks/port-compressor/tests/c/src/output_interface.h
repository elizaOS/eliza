#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The output interface provides an interface for writing to a file, data, etc.

typedef struct OutputInterface_struct OutputInterface;

struct OutputInterface_struct {
  bool (*write)(OutputInterface* enc, const void* data, size_t data_size);
  void* private_data;
};
