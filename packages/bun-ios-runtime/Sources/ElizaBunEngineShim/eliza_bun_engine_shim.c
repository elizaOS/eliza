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
  ELIZA_DEFAULT_CALL_TIMEOUT_MS = 120000,
  ELIZA_MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000,
  ELIZA_MAX_STARTUP_TIMEOUT_MS = 10 * 60 * 1000,
  ELIZA_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024,
  ELIZA_LAST_ERROR_BYTES = 4096,
};

static pthread_mutex_t g_call_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_error_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_state_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_host_callback_mutex = PTHREAD_MUTEX_INITIALIZER;
static int g_running = 0;
static int g_starting = 0;
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
static volatile int g_bun_exited = 0;
static volatile uint32_t g_bun_exit_code = 0;
static eliza_bun_engine_host_call_callback g_host_callback = NULL;
static char g_last_error[ELIZA_LAST_ERROR_BYTES] = {0};

static void close_fd(int *fd);
static void set_last_error(const char *fmt, ...);

static void mark_engine_stopped(void) {
  pthread_mutex_lock(&g_state_mutex);
  g_running = 0;
  g_starting = 0;
  pthread_mutex_unlock(&g_state_mutex);
}

static void mark_engine_ready(void) {
  pthread_mutex_lock(&g_state_mutex);
  g_running = 1;
  g_starting = 0;
  pthread_mutex_unlock(&g_state_mutex);
}

static void on_bun_exit(uint32_t code) {
  pthread_mutex_lock(&g_state_mutex);
  int was_running = g_running;
  pthread_mutex_unlock(&g_state_mutex);
  g_bun_exited = 1;
  g_bun_exit_code = code;
  mark_engine_stopped();
  set_last_error(
      was_running ? "Bun exited with code %u"
                  : "Bun exited before ios-bridge readiness with code %u",
      code);
  close_fd(&g_stdout_write_fd);
  close_fd(&g_stderr_write_fd);
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

static char *join_path_dup(const char *base, const char *leaf) {
  if (!base || !base[0]) return xstrdup(leaf);
  if (!leaf || !leaf[0]) return xstrdup(base);
  size_t base_len = strlen(base);
  size_t leaf_len = strlen(leaf);
  int needs_slash = base[base_len - 1] != '/';
  char *out = (char *)malloc(base_len + (size_t)needs_slash + leaf_len + 1);
  if (!out) return NULL;
  memcpy(out, base, base_len);
  size_t offset = base_len;
  if (needs_slash) out[offset++] = '/';
  memcpy(out + offset, leaf, leaf_len);
  out[offset + leaf_len] = '\0';
  return out;
}

static void ensure_default_env(const char *app_support_dir, const char *bundle_path) {
  if (app_support_dir && app_support_dir[0]) {
    mkdir(app_support_dir, 0700);
    setenv("HOME", app_support_dir, 1);
    setenv("ELIZA_HOME", app_support_dir, 1);
    setenv("ELIZA_IOS_APP_SUPPORT_DIR", app_support_dir, 1);
    setenv("ELIZA_STATE_DIR", app_support_dir, 0);
    setenv("ELIZA_WORKSPACE_DIR", app_support_dir, 0);
    char *pglite_dir = join_path_dup(app_support_dir, ".elizadb");
    if (pglite_dir) {
      setenv("PGLITE_DATA_DIR", pglite_dir, 0);
      free(pglite_dir);
    }
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
  setenv("ELIZA_VAULT_BACKEND", "file", 0);
  setenv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", "1", 0);
  setenv("ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP", "1", 0);
  setenv("ELIZA_PGLITE_DISABLE_EXTENSIONS", "0", 0);
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

static char *extract_json_string_field(const char *json, const char *field) {
  if (!json || !field) return NULL;
  size_t field_len = strlen(field);
  size_t pattern_len = field_len + 3;
  char *pattern = (char *)malloc(pattern_len + 1);
  if (!pattern) return NULL;
  snprintf(pattern, pattern_len + 1, "\"%s\"", field);
  const char *p = strstr(json, pattern);
  free(pattern);
  if (!p) return NULL;
  p += field_len + 2;
  p = strchr(p, ':');
  if (!p) return NULL;
  p++;
  p = skip_ws(p);
  if (*p != '"') return NULL;
  return parse_json_string(&p);
}

static char *extract_json_value_field(const char *json, const char *field) {
  if (!json || !field) return NULL;
  size_t field_len = strlen(field);
  size_t pattern_len = field_len + 3;
  char *pattern = (char *)malloc(pattern_len + 1);
  if (!pattern) return NULL;
  snprintf(pattern, pattern_len + 1, "\"%s\"", field);
  const char *p = strstr(json, pattern);
  free(pattern);
  if (!p) return NULL;
  p += field_len + 2;
  p = strchr(p, ':');
  if (!p) return NULL;
  p++;
  p = skip_ws(p);
  const char *start = p;
  int depth = 0;
  int in_string = 0;
  int escaped = 0;
  while (*p) {
    char ch = *p;
    if (in_string) {
      if (escaped) {
        escaped = 0;
      } else if (ch == '\\') {
        escaped = 1;
      } else if (ch == '"') {
        in_string = 0;
      }
      p++;
      continue;
    }
    if (ch == '"') {
      in_string = 1;
      p++;
      continue;
    }
    if (ch == '{' || ch == '[') {
      depth++;
      p++;
      continue;
    }
    if (ch == '}' || ch == ']') {
      if (depth == 0) break;
      depth--;
      p++;
      continue;
    }
    if (depth == 0 && ch == ',') break;
    p++;
  }
  const char *end = p;
  while (end > start && isspace((unsigned char)*(end - 1))) end--;
  size_t len = (size_t)(end - start);
  char *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  memcpy(out, start, len);
  out[len] = '\0';
  return out;
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

static int env_timeout_ms(const char *name, int fallback_ms, int max_ms) {
  const char *raw = getenv(name);
  if (!raw || raw[0] == '\0') return fallback_ms;
  char *end = NULL;
  long value = strtol(raw, &end, 10);
  if (end == raw || value <= 0) return fallback_ms;
  if (value > max_ms) return max_ms;
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

static int is_host_call_line(const char *line) {
  return line && strstr(line, "\"type\"") && strstr(line, "\"host_call\"");
}

static char *host_callback_missing_json(const char *method) {
  char message[512];
  snprintf(
      message,
      sizeof(message),
      "No native host callback is registered for Bun host call %s",
      method && method[0] ? method : "(missing)");
  return error_json(message);
}

static int service_host_call_line(const char *line) {
  char *call_id = extract_json_string_field(line, "id");
  char *method = extract_json_string_field(line, "method");
  char *payload = extract_json_value_field(line, "payload");
  if (!payload) payload = xstrdup("null");
  if (!call_id || !method || !payload) {
    free(call_id);
    free(method);
    free(payload);
    set_last_error("Malformed Bun host_call frame");
    return -1;
  }

  pthread_mutex_lock(&g_host_callback_mutex);
  eliza_bun_engine_host_call_callback callback = g_host_callback;
  pthread_mutex_unlock(&g_host_callback_mutex);

  int timeout_ms = extract_timeout_ms(line);
  char *envelope = callback
      ? callback(method, payload, timeout_ms)
      : host_callback_missing_json(method);
  if (!envelope) envelope = error_json("Native host callback returned null");

  char *escaped_id = json_escape(call_id);
  if (!escaped_id) {
    free(call_id);
    free(method);
    free(payload);
    free(envelope);
    set_last_error("out of memory while responding to host_call");
    return -1;
  }

  size_t response_len = strlen(escaped_id) + strlen(envelope) + 48;
  char *response = (char *)malloc(response_len);
  if (!response) {
    free(call_id);
    free(method);
    free(payload);
    free(envelope);
    free(escaped_id);
    set_last_error("out of memory while responding to host_call");
    return -1;
  }
  snprintf(
      response,
      response_len,
      "{\"type\":\"host_result\",\"id\":%s,\"envelope\":%s}\n",
      escaped_id,
      envelope);

  int write_result = write_all(g_stdin_write_fd, response, strlen(response));
  free(call_id);
  free(method);
  free(payload);
  free(envelope);
  free(escaped_id);
  free(response);
  if (write_result != 0) {
    set_last_error("failed to write native host_result to Bun bridge");
    return -1;
  }
  return 0;
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
    while (n > 0 && (buffer[n - 1] == '\n' || buffer[n - 1] == '\r')) n--;
    buffer[n] = '\0';
    if (n > 0) set_last_error("Bun stderr: %s", buffer);
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
  close_fd(&g_stderr_read_fd);
  close_fd(&g_stderr_write_fd);
  if (g_stderr_thread_started) {
    pthread_join(g_stderr_thread, NULL);
    g_stderr_thread_started = 0;
  }
}

static void free_argv(char **argv, int argc) {
  if (!argv) return;
  for (int i = 0; i < argc; i++) free(argv[i]);
  free(argv);
}

static char **default_argv(const char *bundle_path, int *argc_out) {
  char **argv = (char **)calloc(5, sizeof(char *));
  if (!argv) return NULL;
  argv[0] = xstrdup("bun");
  argv[1] = xstrdup("--no-install");
  argv[2] = xstrdup(bundle_path);
  argv[3] = xstrdup("ios-bridge");
  argv[4] = xstrdup("--stdio");
  if (!argv[0] || !argv[1] || !argv[2] || !argv[3] || !argv[4]) {
    free_argv(argv, 5);
    return NULL;
  }
  *argc_out = 5;
  return argv;
}

static int option_consumes_value(const char *arg) {
  if (!arg || arg[0] != '-') return 0;
  if (strchr(arg, '=')) return 0;
  return strcmp(arg, "--cwd") == 0 || strcmp(arg, "--env-file") == 0 ||
      strcmp(arg, "--preload") == 0 || strcmp(arg, "--conditions") == 0 ||
      strcmp(arg, "--port") == 0 || strcmp(arg, "-r") == 0 ||
      strcmp(arg, "--require") == 0;
}

static int find_script_arg_index(char **argv, int argc) {
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (!arg) continue;
    if (strstr(arg, "agent-bundle") || strstr(arg, ".js")) return i;
  }
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (!arg || arg[0] == '\0') continue;
    if (arg[0] == '-') {
      if (option_consumes_value(arg)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

static int insert_bundle_arg(char ***argv_inout, int *argc_inout, const char *bundle_path) {
  char **argv = *argv_inout;
  int argc = *argc_inout;
  int insert_at = 1;
  while (insert_at < argc) {
    const char *arg = argv[insert_at];
    if (!arg || arg[0] != '-') break;
    insert_at++;
    if (option_consumes_value(arg) && insert_at < argc) insert_at++;
  }

  char **grown = (char **)realloc(argv, (size_t)(argc + 1) * sizeof(char *));
  if (!grown) return -1;
  argv = grown;
  for (int i = argc; i > insert_at; i--) argv[i] = argv[i - 1];
  argv[insert_at] = xstrdup(bundle_path);
  if (!argv[insert_at]) return -1;
  *argv_inout = argv;
  *argc_inout = argc + 1;
  return 0;
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

  int script_index = find_script_arg_index(argv, argc);
  if (script_index >= 0) {
    free(argv[script_index]);
    argv[script_index] = xstrdup(bundle_path);
    if (!argv[script_index]) {
      free_argv(argv, argc);
      return NULL;
    }
  } else if (insert_bundle_arg(&argv, &argc, bundle_path) != 0) {
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
    if (g_bun_exited) {
      set_last_error("Bun exited before ios-bridge readiness with code %u", g_bun_exit_code);
      return -1;
    }
    if (remaining <= 0) {
      if (g_bun_exited) {
        set_last_error("Bun exited before ios-bridge readiness with code %u", g_bun_exit_code);
      } else {
        set_last_error("ios-bridge did not become ready within %dms", timeout_ms);
      }
      return -2;
    }
    int timed_out = 0;
    int read_timeout = remaining > 250 ? 250 : (int)remaining;
    char *line = read_line_timeout(stdout_fd, read_timeout, &timed_out);
    if (!line) {
      if (timed_out) {
        if (g_bun_exited) {
          set_last_error("Bun exited before ios-bridge readiness with code %u", g_bun_exit_code);
          return -1;
        }
        continue;
      }
      if (g_last_error[0] == '\0') {
        set_last_error("ios-bridge closed before readiness");
      }
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
      free(ready_error);
      return -1;
    }
  }
}

const char *eliza_bun_engine_abi_version(void) {
  return "3";
}

const char *eliza_bun_engine_last_error(void) {
  pthread_mutex_lock(&g_error_mutex);
  static char snapshot[ELIZA_LAST_ERROR_BYTES];
  snprintf(snapshot, sizeof(snapshot), "%s", g_last_error);
  pthread_mutex_unlock(&g_error_mutex);
  return snapshot;
}

int32_t eliza_bun_engine_set_host_callback(
    eliza_bun_engine_host_call_callback callback) {
  pthread_mutex_lock(&g_host_callback_mutex);
  g_host_callback = callback;
  pthread_mutex_unlock(&g_host_callback_mutex);
  return 0;
}

int32_t eliza_bun_engine_start(
    const char *bundle_path,
    const char *argv_json,
    const char *env_json,
    const char *app_support_dir) {
  pthread_mutex_lock(&g_state_mutex);
  if (g_running) {
    pthread_mutex_unlock(&g_state_mutex);
    return 0;
  }
  if (g_starting) {
    pthread_mutex_unlock(&g_state_mutex);
    set_last_error("ElizaBunEngine is already starting");
    return -2;
  }
  g_starting = 1;
  pthread_mutex_unlock(&g_state_mutex);

  set_last_error("");
  g_bun_exited = 0;
  g_bun_exit_code = 0;
  if (!bundle_path || bundle_path[0] == '\0') {
    set_last_error("bundle_path is required");
    mark_engine_stopped();
    return -1;
  }

  int stdin_pipe[2] = {-1, -1};
  int stdout_pipe[2] = {-1, -1};
  int stderr_pipe[2] = {-1, -1};
  if (pipe(stdin_pipe) != 0) {
    set_last_error("failed to create stdin pipe: %s", strerror(errno));
    mark_engine_stopped();
    return -1;
  }
  if (pipe(stdout_pipe) != 0) {
    set_last_error("failed to create stdout pipe: %s", strerror(errno));
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    mark_engine_stopped();
    return -1;
  }
  if (pipe(stderr_pipe) != 0) {
    set_last_error("failed to create stderr pipe: %s", strerror(errno));
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    mark_engine_stopped();
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
    mark_engine_stopped();
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
    mark_engine_stopped();
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

  int startup_timeout_ms = env_timeout_ms(
      "ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS",
      180000,
      ELIZA_MAX_STARTUP_TIMEOUT_MS);
  int ready = wait_for_ready(g_stdout_read_fd, startup_timeout_ms);
  if (ready != 0) {
    eliza_bun_engine_stop();
    return ready;
  }

  mark_engine_ready();
  return 0;
}

int32_t eliza_bun_engine_stop(void) {
  mark_engine_stopped();
  close_fd(&g_stdin_write_fd);
  close_fd(&g_stdin_read_fd);
  close_fd(&g_stdout_read_fd);
  close_fd(&g_stdout_write_fd);
  stop_stderr_drain();
  return 0;
}

int32_t eliza_bun_engine_is_running(void) {
  pthread_mutex_lock(&g_state_mutex);
  int running = g_running && !g_bun_exited;
  pthread_mutex_unlock(&g_state_mutex);
  return running ? 1 : 0;
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
      if (timed_out) {
        return timeout_json(timeout_ms);
      }
      return error_json("Bun bridge closed before returning a response");
    }
    if (is_host_call_line(line)) {
      int host_result = service_host_call_line(line);
      free(line);
      if (host_result != 0) {
        pthread_mutex_unlock(&g_call_mutex);
        return error_json("failed to service native host call");
      }
      continue;
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
