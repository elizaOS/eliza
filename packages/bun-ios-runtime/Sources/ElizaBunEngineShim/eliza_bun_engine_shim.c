#include "eliza_bun_engine.h"
#include "bun_ios.h"

#include <ctype.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

enum {
  ELIZA_STARTUP_TIMEOUT_MS = 30000,
  ELIZA_DEFAULT_CALL_TIMEOUT_MS = 120000,
  ELIZA_MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000,
  ELIZA_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024,
  ELIZA_LAST_ERROR_BYTES = 4096,
};

static pthread_mutex_t g_call_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_error_mutex = PTHREAD_MUTEX_INITIALIZER;
static int g_running = 0;
static uint64_t g_next_id = 1;
static int g_stdin_read_fd = -1;
static int g_stdin_write_fd = -1;
static int g_stdout_read_fd = -1;
static int g_stdout_write_fd = -1;
static int g_stderr_read_fd = -1;
static int g_stderr_write_fd = -1;
static pthread_t g_stderr_thread;
static int g_stderr_thread_started = 0;
static volatile int g_stderr_thread_stop = 0;
static char g_last_error[ELIZA_LAST_ERROR_BYTES] = {0};

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

static int64_t monotonic_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return ((int64_t)ts.tv_sec * 1000) + (ts.tv_nsec / 1000000);
}

static void set_last_error(const char *fmt, ...) {
  pthread_mutex_lock(&g_error_mutex);
  va_list args;
  va_start(args, fmt);
  vsnprintf(g_last_error, sizeof(g_last_error), fmt, args);
  va_end(args);
  pthread_mutex_unlock(&g_error_mutex);
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

static char *timeout_json(int timeout_ms) {
  char message[128];
  snprintf(message, sizeof(message), "Bun bridge call timed out after %dms", timeout_ms);
  set_last_error("%s", message);
  char *escaped = json_escape(message);
  if (!escaped) return xstrdup("{\"ok\":false,\"error\":\"timeout\",\"code\":\"timeout\"}");
  size_t needed = strlen(escaped) + 80;
  char *out = (char *)malloc(needed);
  if (!out) {
    free(escaped);
    return NULL;
  }
  snprintf(
      out,
      needed,
      "{\"ok\":false,\"error\":%s,\"code\":\"timeout\",\"timeoutMs\":%d}",
      escaped,
      timeout_ms);
  free(escaped);
  return out;
}

static char *error_json(const char *message) {
  set_last_error("%s", message ? message : "unknown error");
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
      if (cap >= ELIZA_MAX_PROTOCOL_LINE_BYTES) {
        set_last_error(
            "Bun bridge protocol line exceeded %d bytes",
            ELIZA_MAX_PROTOCOL_LINE_BYTES);
        free(out);
        return NULL;
      }
      cap *= 2;
      if (cap > ELIZA_MAX_PROTOCOL_LINE_BYTES) cap = ELIZA_MAX_PROTOCOL_LINE_BYTES;
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

static char *dirname_dup(const char *path) {
  if (!path || !path[0]) return xstrdup(".");
  const char *slash = strrchr(path, '/');
  if (!slash) return xstrdup(".");
  if (slash == path) return xstrdup("/");
  size_t len = (size_t)(slash - path);
  char *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  memcpy(out, path, len);
  out[len] = '\0';
  return out;
}

static void ensure_default_env(const char *app_support_dir, const char *bundle_path) {
  if (app_support_dir && app_support_dir[0]) {
    mkdir(app_support_dir, 0700);
    setenv("HOME", app_support_dir, 1);
    setenv("ELIZA_HOME", app_support_dir, 1);
    setenv("ELIZA_IOS_APP_SUPPORT_DIR", app_support_dir, 1);
  }
  if (bundle_path && bundle_path[0]) {
    setenv("ELIZA_IOS_AGENT_BUNDLE", bundle_path, 1);
    char *asset_dir = dirname_dup(bundle_path);
    if (asset_dir) {
      setenv("ELIZA_IOS_AGENT_ASSET_DIR", asset_dir, 1);
      free(asset_dir);
    }
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

static char *read_line_timeout(int fd, int timeout_ms, int *timed_out) {
  if (timed_out) *timed_out = 0;
  size_t cap = 4096;
  size_t len = 0;
  char *out = (char *)malloc(cap);
  if (!out) return NULL;
  int64_t deadline = monotonic_ms() + timeout_ms;
  for (;;) {
    int64_t remaining = deadline - monotonic_ms();
    if (remaining <= 0) {
      if (timed_out) *timed_out = 1;
      free(out);
      return NULL;
    }

    fd_set readfds;
    FD_ZERO(&readfds);
    FD_SET(fd, &readfds);
    struct timeval tv;
    tv.tv_sec = (time_t)(remaining / 1000);
    tv.tv_usec = (suseconds_t)((remaining % 1000) * 1000);
    int ready = select(fd + 1, &readfds, NULL, NULL, &tv);
    if (ready < 0) {
      if (errno == EINTR) continue;
      free(out);
      return NULL;
    }
    if (ready == 0) {
      if (timed_out) *timed_out = 1;
      free(out);
      return NULL;
    }

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
      if (cap >= ELIZA_MAX_PROTOCOL_LINE_BYTES) {
        set_last_error(
            "Bun bridge protocol line exceeded %d bytes",
            ELIZA_MAX_PROTOCOL_LINE_BYTES);
        free(out);
        return NULL;
      }
      cap *= 2;
      if (cap > ELIZA_MAX_PROTOCOL_LINE_BYTES) cap = ELIZA_MAX_PROTOCOL_LINE_BYTES;
      char *grown = (char *)realloc(out, cap);
      if (!grown) {
        set_last_error("out of memory while reading Bun bridge protocol line");
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

static int extract_timeout_ms(const char *json) {
  int timeout_ms = ELIZA_DEFAULT_CALL_TIMEOUT_MS;
  const char *p = json ? strstr(json, "\"timeoutMs\"") : NULL;
  if (!p) return timeout_ms;
  p = strchr(p, ':');
  if (!p) return timeout_ms;
  p++;
  p = skip_ws(p);
  if (!isdigit((unsigned char)*p)) return timeout_ms;
  long value = 0;
  while (isdigit((unsigned char)*p)) {
    value = (value * 10) + (*p - '0');
    if (value > ELIZA_MAX_CALL_TIMEOUT_MS) {
      value = ELIZA_MAX_CALL_TIMEOUT_MS;
      break;
    }
    p++;
  }
  if (value <= 0) return timeout_ms;
  return (int)value;
}

static int is_ready_line(const char *line, char **error_out) {
  if (!line || !strstr(line, "\"type\"") || !strstr(line, "\"ready\"")) return 0;
  if (strstr(line, "\"ok\":false")) {
    if (error_out) *error_out = xstrdup(line);
    return -1;
  }
  return strstr(line, "\"ok\":true") ? 1 : 0;
}

static void *stderr_drain_thread(void *arg) {
  int fd = *(int *)arg;
  free(arg);
  char buffer[1024];
  while (!g_stderr_thread_stop) {
    fd_set readfds;
    FD_ZERO(&readfds);
    FD_SET(fd, &readfds);
    struct timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = 250000;
    int ready = select(fd + 1, &readfds, NULL, NULL, &tv);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return NULL;
    }
    if (ready == 0) continue;

    ssize_t n = read(fd, buffer, sizeof(buffer) - 1);
    if (n < 0) {
      if (errno == EINTR) continue;
      return NULL;
    }
    if (n == 0) return NULL;
    buffer[n] = '\0';
    fprintf(stderr, "[ElizaBunEngine stderr] %s", buffer);
    if (buffer[n - 1] != '\n') fputc('\n', stderr);
    fflush(stderr);
  }
  return NULL;
}

static int start_stderr_drain(int fd) {
  int *arg = (int *)malloc(sizeof(int));
  if (!arg) return -1;
  *arg = fd;
  g_stderr_thread_stop = 0;
  if (pthread_create(&g_stderr_thread, NULL, stderr_drain_thread, arg) != 0) {
    free(arg);
    return -1;
  }
  g_stderr_thread_started = 1;
  return 0;
}

static void stop_stderr_drain(void) {
  g_stderr_thread_stop = 1;
  close_fd(&g_stderr_write_fd);
  if (g_stderr_thread_started) {
    pthread_join(g_stderr_thread, NULL);
    g_stderr_thread_started = 0;
  }
  close_fd(&g_stderr_read_fd);
}

static void free_argv(char **argv, int argc) {
  if (!argv) return;
  for (int i = 0; i < argc; i++) free(argv[i]);
  free(argv);
}

static char **default_argv(const char *bundle_path, int *argc_out) {
  char **argv = (char **)calloc(4, sizeof(char *));
  if (!argv) return NULL;
  argv[0] = xstrdup("bun");
  argv[1] = xstrdup(bundle_path);
  argv[2] = xstrdup("ios-bridge");
  argv[3] = xstrdup("--stdio");
  if (!argv[0] || !argv[1] || !argv[2] || !argv[3]) {
    free_argv(argv, 4);
    return NULL;
  }
  *argc_out = 4;
  return argv;
}

static char **parse_argv_json(const char *json, const char *bundle_path, int *argc_out) {
  *argc_out = 0;
  const char *p = skip_ws(json);
  if (!p || !*p) return default_argv(bundle_path, argc_out);
  if (*p != '[') return NULL;
  p++;

  int cap = 8;
  int argc = 0;
  char **argv = (char **)calloc((size_t)cap, sizeof(char *));
  if (!argv) return NULL;
  while (*p) {
    p = skip_ws(p);
    if (*p == ']') {
      p++;
      break;
    }
    if (*p != '"') {
      free_argv(argv, argc);
      return NULL;
    }
    if (argc >= cap) {
      cap *= 2;
      char **grown = (char **)realloc(argv, (size_t)cap * sizeof(char *));
      if (!grown) {
        free_argv(argv, argc);
        return NULL;
      }
      argv = grown;
    }
    argv[argc] = parse_json_string(&p);
    if (!argv[argc]) {
      free_argv(argv, argc);
      return NULL;
    }
    argc++;
    p = skip_ws(p);
    if (*p == ',') {
      p++;
      continue;
    }
    if (*p == ']') {
      p++;
      break;
    }
    free_argv(argv, argc);
    return NULL;
  }

  if (argc < 2) {
    free_argv(argv, argc);
    return default_argv(bundle_path, argc_out);
  }

  free(argv[1]);
  argv[1] = xstrdup(bundle_path);
  if (!argv[1]) {
    free_argv(argv, argc);
    return NULL;
  }
  *argc_out = argc;
  return argv;
}

static int wait_for_ready(int stdout_fd, int timeout_ms) {
  int64_t deadline = monotonic_ms() + timeout_ms;
  for (;;) {
    int64_t remaining = deadline - monotonic_ms();
    if (remaining <= 0) {
      set_last_error("ios-bridge did not become ready within %dms", timeout_ms);
      fprintf(stderr, "[ElizaBunEngine] %s\n", eliza_bun_engine_last_error());
      return -2;
    }
    int timed_out = 0;
    char *line = read_line_timeout(stdout_fd, (int)remaining, &timed_out);
    if (!line) {
      if (timed_out) {
        set_last_error("ios-bridge did not become ready within %dms", timeout_ms);
        fprintf(stderr, "[ElizaBunEngine] %s\n", eliza_bun_engine_last_error());
        return -2;
      }
      if (g_last_error[0] == '\0') {
        set_last_error("ios-bridge closed before readiness");
      }
      fprintf(stderr, "[ElizaBunEngine] ios-bridge closed before readiness\n");
      return -1;
    }
    char *ready_error = NULL;
    int ready = is_ready_line(line, &ready_error);
    free(line);
    if (ready > 0) return 0;
    if (ready < 0) {
      set_last_error(
          "ios-bridge readiness failed: %s",
          ready_error ? ready_error : "unknown error");
      fprintf(stderr, "[ElizaBunEngine] %s\n", eliza_bun_engine_last_error());
      free(ready_error);
      return -1;
    }
  }
}

const char *eliza_bun_engine_abi_version(void) {
  return "1";
}

const char *eliza_bun_engine_last_error(void) {
  pthread_mutex_lock(&g_error_mutex);
  static char snapshot[ELIZA_LAST_ERROR_BYTES];
  snprintf(snapshot, sizeof(snapshot), "%s", g_last_error);
  pthread_mutex_unlock(&g_error_mutex);
  return snapshot;
}

int32_t eliza_bun_engine_start(
    const char *bundle_path,
    const char *argv_json,
    const char *env_json,
    const char *app_support_dir) {
  if (g_running) return 0;
  set_last_error("");
  if (!bundle_path || bundle_path[0] == '\0') {
    set_last_error("bundle_path is required");
    return -1;
  }

  int stdin_pipe[2] = {-1, -1};
  int stdout_pipe[2] = {-1, -1};
  int stderr_pipe[2] = {-1, -1};
  if (pipe(stdin_pipe) != 0) {
    set_last_error("failed to create stdin pipe: %s", strerror(errno));
    return -1;
  }
  if (pipe(stdout_pipe) != 0) {
    set_last_error("failed to create stdout pipe: %s", strerror(errno));
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    return -1;
  }
  if (pipe(stderr_pipe) != 0) {
    set_last_error("failed to create stderr pipe: %s", strerror(errno));
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    return -1;
  }

  apply_env_json(env_json);
  ensure_default_env(app_support_dir, bundle_path);

  int argc = 0;
  char **args = parse_argv_json(argv_json, bundle_path, &argc);
  if (!args || argc <= 0) {
    set_last_error("failed to parse argv JSON for Bun engine");
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    close(stderr_pipe[0]);
    close(stderr_pipe[1]);
    return -1;
  }

  int result = bun_start(
      argc,
      (const char **)args,
      stdin_pipe[0],
      stdout_pipe[1],
      stderr_pipe[1],
      on_bun_exit);
  free_argv(args, argc);
  if (result != 0) {
    set_last_error("bun_start failed with code %d", result);
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    close(stderr_pipe[0]);
    close(stderr_pipe[1]);
    return -1;
  }

  g_stdin_read_fd = stdin_pipe[0];
  g_stdin_write_fd = stdin_pipe[1];
  g_stdout_read_fd = stdout_pipe[0];
  g_stdout_write_fd = stdout_pipe[1];
  g_stderr_read_fd = stderr_pipe[0];
  g_stderr_write_fd = stderr_pipe[1];

  if (start_stderr_drain(g_stderr_read_fd) != 0) {
    set_last_error("failed to start stderr drain thread");
    eliza_bun_engine_stop();
    return -1;
  }

  int ready = wait_for_ready(g_stdout_read_fd, ELIZA_STARTUP_TIMEOUT_MS);
  if (ready != 0) {
    eliza_bun_engine_stop();
    return ready;
  }

  g_running = 1;
  return 0;
}

int32_t eliza_bun_engine_stop(void) {
  g_running = 0;
  close_fd(&g_stdin_write_fd);
  close_fd(&g_stdin_read_fd);
  close_fd(&g_stdout_read_fd);
  close_fd(&g_stdout_write_fd);
  stop_stderr_drain();
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
  int timeout_ms = extract_timeout_ms(payload_json);
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

  int64_t deadline = monotonic_ms() + timeout_ms;
  for (;;) {
    int64_t remaining = deadline - monotonic_ms();
    if (remaining <= 0) {
      pthread_mutex_unlock(&g_call_mutex);
      return timeout_json(timeout_ms);
    }
    int timed_out = 0;
    char *line = read_line_timeout(g_stdout_read_fd, (int)remaining, &timed_out);
    if (!line) {
      pthread_mutex_unlock(&g_call_mutex);
      if (timed_out) return timeout_json(timeout_ms);
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
