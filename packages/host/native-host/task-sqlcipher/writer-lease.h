/* MIT. Linux writer-owned advisory lease. Never unlink the stable lock inode.
 */
#ifndef ELIZA_TASK_WRITER_LEASE_H
#define ELIZA_TASK_WRITER_LEASE_H
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
typedef struct {
  int fd;
  char *database_path;
  char *lock_path;
  dev_t device;
  ino_t inode;
} task_writer_lease;
static int task_writer_current(task_writer_lease *lease) {
  struct stat descriptor, named;
  return lease && lease->fd >= 0 && fstat(lease->fd, &descriptor) == 0 &&
         lstat(lease->lock_path, &named) == 0 && S_ISREG(named.st_mode) &&
         named.st_nlink == 1 && named.st_uid == geteuid() &&
         (named.st_mode & 0777) == 0600 && named.st_dev == lease->device &&
         named.st_ino == lease->inode && descriptor.st_dev == named.st_dev &&
         descriptor.st_ino == named.st_ino;
}
static void task_writer_release(task_writer_lease *lease) {
  if (!lease)
    return;
  if (lease->fd >= 0)
    close(lease->fd);
  free(lease->database_path);
  free(lease->lock_path);
  free(lease);
}
static task_writer_lease *task_writer_acquire(const char *path) {
  if (!path || path[0] != '/' || strlen(path) > 4096)
    return NULL;
  task_writer_lease *lease = calloc(1, sizeof(*lease));
  if (!lease)
    return NULL;
  lease->fd = -1;
  lease->database_path = strdup(path);
  lease->lock_path = malloc(strlen(path) + sizeof(".writer.lock"));
  if (!lease->database_path || !lease->lock_path)
    goto failed;
  strcpy(lease->lock_path, path);
  strcat(lease->lock_path, ".writer.lock");
  lease->fd =
      open(lease->lock_path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lease->fd < 0)
    goto failed;
  struct stat state;
  if (fstat(lease->fd, &state) || !S_ISREG(state.st_mode) ||
      state.st_nlink != 1 || state.st_uid != geteuid() ||
      (state.st_mode & 0777) != 0600)
    goto failed;
  lease->device = state.st_dev;
  lease->inode = state.st_ino;
  if (flock(lease->fd, LOCK_EX | LOCK_NB) || !task_writer_current(lease))
    goto failed;
  return lease;
failed:
  task_writer_release(lease);
  return NULL;
}
#endif
