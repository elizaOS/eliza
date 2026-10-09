#include "memory_mapper.h"

#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

int map_file(const char* filename, const uint8_t** data, size_t* data_size) {
  int fd = open(filename, O_RDONLY);
  if (fd < 0) {
    fprintf(stderr, "could not open %s\n", filename);
    return -1;
  }
  struct stat buf;
  if (fstat(fd, &buf) < 0) {
    fprintf(stderr, "could not stat %s\n", filename);
    return -1;
  }
  void* map = mmap(0, buf.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (map == MAP_FAILED) {
    fprintf(stderr, "could not mmap %s\n", filename);
    return -1;
  }
  if (close(fd) < 0) {
    fprintf(stderr, "could not close fd %d\n", fd);
    return -1;
  }
  *data_size = buf.st_size;
  *data = (uint8_t*)map;
  return 0;
}

int map_anonymous(size_t data_size, uint8_t** data) {
  void* map = mmap(0, data_size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, 0, 0);
  if (map == MAP_FAILED) {
    fprintf(stderr, "could map anonymous memory of size %ld\n", data_size);
    return -1;
  }
  *data = (uint8_t*)map;
  return 0;
}

int unmap(const uint8_t* data, size_t data_size) {
  if (munmap((void*)data, data_size) < 0) {
    fprintf(stderr, "could not munmap data\n");
    return -1;
  }
  return 0;
}
