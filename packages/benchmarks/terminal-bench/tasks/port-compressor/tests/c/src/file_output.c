#include "file_output.h"

static bool file_write(OutputInterface* output, const void* data, size_t data_size) {
  FILE* file = (FILE*)output->private_data;
  return fwrite(data, data_size, 1, file) == 1;
}

void file_output_new(OutputInterface* output, FILE* file) {
  output->write = file_write;
  output->private_data = file;
}
