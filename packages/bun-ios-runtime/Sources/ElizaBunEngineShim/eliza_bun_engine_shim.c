#include "eliza_bun_engine.h"
#include "bun_ios.h"

#include <ctype.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static pthread_mutex_t g_call_mutex = PTHREAD_MUTEX_INITIALIZER;
static int g_running = 0;
static uint64_t g_next_id = 1;
static int g_stdin_read_fd = -1;
static int g_stdin_write_fd = -1;
static int g_stdout_read_fd = -1;
static int g_stdout_write_fd = -1;

static void on_bun_exit(uint32_t code) {
  (void)code;
  g_running = 0;
}

static void close_fd(int *fd) {
  if (*fd >= 0) {
    close(*fd);
    *fd = -1;
  }
}

static char *xstrdup(const char *value) {
  if (!value) value = "";
  size_t len = strlen(value);
  char *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  memcpy(out, value, len + 1);
  return out;
}

static char *json_escape(const char *value) {
  if (!value) value = "";
  size_t needed = 3;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    switch (*p) {
      case '"':
      case '\\':
      case '\n':
      case '\r':
      case '\t':
        needed += 2;
        break;
      default:
        needed += *p < 0x20 ? 6 : 1;
        break;
    }
  }
  char *out = (char *)malloc(needed);
  if (!out) return NULL;
  char *w = out;
  *w++ = '"';
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    switch (*p) {
      case '"':
        *w++ = '\\';
        *w++ = '"';
        break;
      case '\\':
        *w++ = '\\';
        *w++ = '\\';
        break;
      case '\n':
        *w++ = '\\';
        *w++ = 'n';
        break;
      case '\r':
        *w++ = '\\';
        *w++ = 'r';
        break;
      case '\t':
        *w++ = '\\';
        *w++ = 't';
        break;
      default:
        if (*p < 0x20) {
          snprintf(w, 7, "\\u%04x", *p);
          w += 6;
        } else {
          *w++ = (char)*p;
        }
        break;
    }
  }
  *w++ = '"';
  *w = '\0';
  return out;
}

static char *error_json(const char *message) {
  char *escaped = json_escape(message);
  if (!escaped) return xstrdup("{\"ok\":false,\"error\":\"out of memory\"}");
  size_t needed = strlen(escaped) + 24;
  char *out = (char *)malloc(needed);
  if (!out) {
    free(escaped);
    return NULL;
  }
  snprintf(out, needed, "{\"ok\":false,\"error\":%s}", escaped);
  free(escaped);
  return out;
}

static const char *skip_ws(const char *p) {
  while (p && *p && isspace((unsigned char)*p)) p++;
  return p;
}

static char *parse_json_string(const char **cursor) {
  const char *p = skip_ws(*cursor);
  if (*p != '"') return NULL;
  p++;
  size_t cap = 32;
  size_t len = 0;
  char *out = (char *)malloc(cap);
  if (!out) return NULL;
  while (*p && *p != '"') {
    char ch = *p++;
    if (ch == '\\') {
      char esc = *p++;
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          ch = esc;
          break;
        case 'n':
          ch = '\n';
          break;
        case 'r':
          ch = '\r';
          break;
        case 't':
          ch = '\t';
          break;
        case 'b':
          ch = '\b';
          break;
        case 'f':
          ch = '\f';
          break;
        case 'u':
          ch = '?';
          for (int i = 0; i < 4 && isxdigit((unsigned char)*p); i++) p++;
          break;
        default:
          ch = esc ? esc : '\\';
          break;
      }
    }
    if (len + 2 > cap) {
      cap *= 2;
      char *grown = (char *)realloc(out, cap);
      if (!grown) {
        free(out);
        return NULL;
      }
      out = grown;
    }
    out[len++] = ch;
  }
  if (*p == '"') p++;
  out[len] = '\0';
  *cursor = p;
  return out;
}

static void apply_env_json(const char *json) {
  if (!json) return;
  const char *p = skip_ws(json);
  if (*p != '{') return;
  p++;
  while (*p) {
    p = skip_ws(p);
    if (*p == '}') return;
    char *key = parse_json_string(&p);
    if (!key) return;
    p = skip_ws(p);
    if (*p != ':') {
      free(key);
      return;
    }
    p++;
    p = skip_ws(p);
    char *value = NULL;
    if (*p == '"') {
      value = parse_json_string(&p);
    } else {
      const char *start = p;
      while (*p && *p != ',' && *p != '}') p++;
      size_t len = (size_t)(p - start);
      value = (char *)malloc(len + 1);
      if (value) {
        memcpy(value, start, len);
        value[len] = '\0';
      }
    }
    if (value && key[0] != '\0') setenv(key, value, 1);
    free(key);
    free(value);
    p = skip_ws(p);
    if (*p == ',') p++;
  }
}

static void ensure_default_env(const char *app_support_dir, const char *bundle_path) {
  if (app_support_dir && app_support_dir[0]) {
    mkdir(app_support_dir, 0700);
    setenv("HOME", app_support_dir, 1);
    setenv("ELIZA_HOME", app_support_dir, 1);
    setenv("ELIZA_IOS_APP_SUPPORT_DIR", app_support_dir, 1);
    chdir(app_support_dir);
  }
  if (bundle_path && bundle_path[0]) {
    setenv("ELIZA_IOS_AGENT_BUNDLE", bundle_path, 1);
  }
  setenv("ELIZA_PLATFORM", "ios", 0);
  setenv("ELIZA_MOBILE_PLATFORM", "ios", 0);
  setenv("ELIZA_IOS_LOCAL_BACKEND", "1", 0);
  setenv("ELIZA_HEADLESS", "1", 0);
  setenv("LOG_LEVEL", "error", 0);
  setenv("GIGACAGE_ENABLED", "0", 0);
}

static int write_all(int fd, const char *data, size_t len) {
  size_t written = 0;
  while (written < len) {
    ssize_t n = write(fd, data + written, len - written);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (n == 0) return -1;
    written += (size_t)n;
  }
  return 0;
}

static char *read_line(int fd) {
  size_t cap = 4096;
  size_t len = 0;
  char *out = (char *)malloc(cap);
  if (!out) return NULL;
  for (;;) {
    char ch;
    ssize_t n = read(fd, &ch, 1);
    if (n < 0) {
      if (errno == EINTR) continue;
      free(out);
      return NULL;
    }
    if (n == 0) {
      free(out);
      return NULL;
    }
    if (ch == '\n') {
      out[len] = '\0';
      return out;
    }
    if (ch == '\r') continue;
    if (len + 2 > cap) {
      cap *= 2;
      char *grown = (char *)realloc(out, cap);
      if (!grown) {
        free(out);
        return NULL;
      }
      out = grown;
    }
    out[len++] = ch;
  }
}

static int64_t extract_line_id(const char *line) {
  const char *p = strstr(line, "\"id\"");
  if (!p) return -1;
  p = strchr(p, ':');
  if (!p) return -1;
  p++;
  p = skip_ws(p);
  if (!isdigit((unsigned char)*p)) return -1;
  int64_t id = 0;
  while (isdigit((unsigned char)*p)) {
    id = (id * 10) + (*p - '0');
    p++;
  }
  return id;
}

const char *eliza_bun_engine_abi_version(void) {
  return "1";
}

int32_t eliza_bun_engine_start(
    const char *bundle_path,
    const char *argv_json,
    const char *env_json,
    const char *app_support_dir) {
  (void)argv_json;
  if (g_running) return 0;
  if (!bundle_path || bundle_path[0] == '\0') return -1;

  int stdin_pipe[2] = {-1, -1};
  int stdout_pipe[2] = {-1, -1};
  if (pipe(stdin_pipe) != 0) return -1;
  if (pipe(stdout_pipe) != 0) {
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    return -1;
  }

  apply_env_json(env_json);
  ensure_default_env(app_support_dir, bundle_path);

  const char *working_dir =
      (app_support_dir && app_support_dir[0]) ? app_support_dir : "bun";
  const char *args[] = {
      working_dir,
      bundle_path,
      "ios-bridge",
      "--stdio",
  };
  int result = bun_start(
      4,
      args,
      stdin_pipe[0],
      stdout_pipe[1],
      stdout_pipe[1],
      on_bun_exit);
  if (result != 0) {
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    return -1;
  }

  g_stdin_read_fd = stdin_pipe[0];
  g_stdin_write_fd = stdin_pipe[1];
  g_stdout_read_fd = stdout_pipe[0];
  g_stdout_write_fd = stdout_pipe[1];
  g_running = 1;
  return 0;
}

int32_t eliza_bun_engine_stop(void) {
  g_running = 0;
  close_fd(&g_stdin_write_fd);
  close_fd(&g_stdin_read_fd);
  close_fd(&g_stdout_read_fd);
  close_fd(&g_stdout_write_fd);
  return 0;
}

char *eliza_bun_engine_call(const char *method, const char *payload_json) {
  if (!g_running || g_stdin_write_fd < 0 || g_stdout_read_fd < 0) {
    return error_json("ElizaBunEngine is not running");
  }
  if (!method || method[0] == '\0') {
    return error_json("method is required");
  }

  pthread_mutex_lock(&g_call_mutex);
  uint64_t id = g_next_id++;
  char *escaped_method = json_escape(method);
  if (!escaped_method) {
    pthread_mutex_unlock(&g_call_mutex);
    return error_json("out of memory");
  }
  const char *payload = payload_json && payload_json[0] ? payload_json : "null";
  size_t req_len = strlen(escaped_method) + strlen(payload) + 96;
  char *request = (char *)malloc(req_len);
  if (!request) {
    free(escaped_method);
    pthread_mutex_unlock(&g_call_mutex);
    return error_json("out of memory");
  }
  snprintf(
      request,
      req_len,
      "{\"id\":%llu,\"method\":%s,\"payload\":%s}\n",
      (unsigned long long)id,
      escaped_method,
      payload);
  free(escaped_method);

  if (write_all(g_stdin_write_fd, request, strlen(request)) != 0) {
    free(request);
    pthread_mutex_unlock(&g_call_mutex);
    return error_json("failed to write request to Bun bridge");
  }
  free(request);

  for (;;) {
    char *line = read_line(g_stdout_read_fd);
    if (!line) {
      pthread_mutex_unlock(&g_call_mutex);
      return error_json("Bun bridge closed before returning a response");
    }
    if (extract_line_id(line) == (int64_t)id) {
      pthread_mutex_unlock(&g_call_mutex);
      return line;
    }
    free(line);
  }
}

void eliza_bun_engine_free(void *ptr) {
  free(ptr);
}
