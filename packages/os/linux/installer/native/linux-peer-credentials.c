#define _GNU_SOURCE

#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "node-api-minimal.h"

#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif

typedef struct {
  int fd;
  pid_t pid;
} peer_process_handle;

static void throw_errno(napi_env env, const char *operation) {
  char message[256];
  snprintf(message, sizeof(message), "%s failed: %s", operation,
           strerror(errno));
  napi_throw_error(env, NULL, message);
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  peer_process_handle *handle = data;
  if (handle != NULL) {
    if (handle->fd >= 0) {
      close(handle->fd);
    }
    free(handle);
  }
}

static peer_process_handle *unwrap_handle(napi_env env,
                                          napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) {
    napi_throw_error(env, NULL, "Unable to inspect native pidfd handle.");
    return NULL;
  }
  peer_process_handle *handle = NULL;
  if (napi_unwrap(env, self, (void **)&handle) != napi_ok || handle == NULL) {
    napi_throw_error(env, NULL, "Native pidfd handle is invalid.");
    return NULL;
  }
  return handle;
}

static napi_value handle_is_alive(napi_env env, napi_callback_info info) {
  peer_process_handle *handle = unwrap_handle(env, info);
  if (handle == NULL) {
    return NULL;
  }
  if (handle->fd < 0) {
    napi_throw_error(env, NULL, "Native pidfd handle is closed.");
    return NULL;
  }

  struct pollfd descriptor = {
      .fd = handle->fd,
      .events = POLLIN,
      .revents = 0,
  };
  int result;
  do {
    result = poll(&descriptor, 1, 0);
  } while (result < 0 && errno == EINTR);
  if (result < 0) {
    throw_errno(env, "poll(pidfd)");
    return NULL;
  }

  napi_value alive;
  if (napi_get_boolean(env, result == 0, &alive) != napi_ok) {
    napi_throw_error(env, NULL, "Unable to return pidfd liveness.");
    return NULL;
  }
  return alive;
}

static napi_value handle_close(napi_env env, napi_callback_info info) {
  peer_process_handle *handle = unwrap_handle(env, info);
  if (handle == NULL) {
    return NULL;
  }
  if (handle->fd >= 0) {
    int descriptor = handle->fd;
    handle->fd = -1;
    if (close(descriptor) != 0) {
      throw_errno(env, "close(pidfd)");
      return NULL;
    }
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static bool set_int32(napi_env env, napi_value object, const char *name,
                      int32_t value) {
  napi_value number;
  return napi_create_int32(env, value, &number) == napi_ok &&
         napi_set_named_property(env, object, name, number) == napi_ok;
}

static bool set_uint32(napi_env env, napi_value object, const char *name,
                       uint32_t value) {
  napi_value number;
  return napi_create_uint32(env, value, &number) == napi_ok &&
         napi_set_named_property(env, object, name, number) == napi_ok;
}

static napi_value capture_descriptor(napi_env env, int socket_fd) {
  int socket_domain = 0;
  socklen_t socket_domain_length = sizeof(socket_domain);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_DOMAIN, &socket_domain,
                 &socket_domain_length) != 0) {
    throw_errno(env, "validate accepted AF_UNIX socket");
    return NULL;
  }
  if (socket_domain_length != sizeof(socket_domain) ||
      socket_domain != AF_UNIX) {
    errno = ENOTSOCK;
    throw_errno(env, "validate accepted AF_UNIX socket");
    return NULL;
  }

  struct ucred credentials;
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &credentials,
                 &credentials_length) != 0) {
    throw_errno(env, "getsockopt(SO_PEERCRED)");
    return NULL;
  }
  if (credentials_length != sizeof(credentials)) {
    errno = EPROTO;
    throw_errno(env, "getsockopt(SO_PEERCRED)");
    return NULL;
  }
  if (credentials.pid <= 0) {
    errno = EPROTO;
    throw_errno(env, "getsockopt(SO_PEERCRED)");
    return NULL;
  }

  int pidfd = -1;
  socklen_t pidfd_length = sizeof(pidfd);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERPIDFD, &pidfd,
                 &pidfd_length) != 0) {
    throw_errno(env, "getsockopt(SO_PEERPIDFD)");
    return NULL;
  }
  if (pidfd_length != sizeof(pidfd) || pidfd < 0) {
    if (pidfd >= 0) {
      close(pidfd);
    }
    errno = EPROTO;
    throw_errno(env, "getsockopt(SO_PEERPIDFD)");
    return NULL;
  }

  peer_process_handle *handle = calloc(1, sizeof(*handle));
  if (handle == NULL) {
    close(pidfd);
    napi_throw_error(env, NULL, "Unable to allocate native pidfd handle.");
    return NULL;
  }
  handle->fd = pidfd;
  handle->pid = credentials.pid;

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !set_int32(env, result, "pid", credentials.pid) ||
      !set_uint32(env, result, "uid", credentials.uid) ||
      !set_uint32(env, result, "gid", credentials.gid)) {
    finalize_handle(env, handle, NULL);
    napi_throw_error(env, NULL, "Unable to construct native peer identity.");
    return NULL;
  }

  napi_property_descriptor methods[] = {
      {.utf8name = "isAlive", .method = handle_is_alive,
       .attributes = napi_default},
      {.utf8name = "close", .method = handle_close,
       .attributes = napi_default},
  };
  if (napi_define_properties(env, result, 2, methods) != napi_ok) {
    finalize_handle(env, handle, NULL);
    napi_throw_error(env, NULL, "Unable to construct native pidfd methods.");
    return NULL;
  }
  // Wrap only after every other fallible construction step. Once ownership is
  // transferred to N-API, no later branch may free the handle directly.
  if (napi_wrap(env, result, handle, finalize_handle, NULL, NULL) != napi_ok) {
    finalize_handle(env, handle, NULL);
    napi_throw_error(env, NULL, "Unable to retain native pidfd handle.");
    return NULL;
  }
  return result;
}

static napi_value capture(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1) {
    napi_throw_type_error(env, NULL,
                          "capture requires one accepted socket descriptor.");
    return NULL;
  }
  int32_t socket_fd;
  if (napi_get_value_int32(env, argv[0], &socket_fd) != napi_ok ||
      socket_fd < 0) {
    napi_throw_type_error(env, NULL,
                          "Accepted socket descriptor must be non-negative.");
    return NULL;
  }
  return capture_descriptor(env, socket_fd);
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {
          .utf8name = "capture",
          .method = capture,
          .attributes = napi_default,
      },
  };
  if (napi_define_properties(env, exports,
                             sizeof(descriptors) / sizeof(descriptors[0]),
                             descriptors) != napi_ok) {
    napi_throw_error(env, NULL,
                     "Unable to initialize Linux peer credential module.");
  }
  return exports;
}

NAPI_EXPORT napi_value napi_register_module_v1(napi_env env,
                                                napi_value exports) {
  return initialize(env, exports);
}
