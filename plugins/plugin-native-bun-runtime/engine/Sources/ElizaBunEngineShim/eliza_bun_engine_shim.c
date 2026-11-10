#include "eliza_bun_engine.h"
#include "bun_ios.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sqlite3.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if defined(ELIZA_IOS_DISABLE_DYNAMIC_LOADING)
__attribute__((visibility("hidden"))) void *dlopen(
    const char *path,
    int mode) {
  (void)path;
  (void)mode;
  errno = ENOTSUP;
  return NULL;
}

__attribute__((visibility("hidden"))) void *dlsym(
    void *handle,
    const char *symbol) {
  (void)handle;
  (void)symbol;
  errno = ENOTSUP;
  return NULL;
}

__attribute__((visibility("hidden"))) int sqlite3_load_extension(
    sqlite3 *db,
    const char *zFile,
    const char *zProc,
    char **pzErrMsg) {
  (void)db;
  (void)zFile;
  (void)zProc;
  if (pzErrMsg) *pzErrMsg = NULL;
  return SQLITE_ERROR;
}
#endif

#if defined(ELIZA_IOS_DISABLE_PROCESS_SPAWN)
__attribute__((visibility("hidden"))) pid_t fork(void) {
  errno = ENOTSUP;
  return -1;
}

__attribute__((visibility("hidden"))) int execve(
    const char *path,
    char *const argv[],
    char *const envp[]) {
  (void)path;
  (void)argv;
  (void)envp;
  errno = ENOTSUP;
  return -1;
}

__attribute__((visibility("hidden"))) int pthread_atfork(
    void (*prepare)(void),
    void (*parent)(void),
    void (*child)(void)) {
  (void)prepare;
  (void)parent;
  (void)child;
  return 0;
}
#endif

#if defined(ELIZA_IOS_NO_JIT)
__attribute__((visibility("hidden"))) int mprotect(
    void *addr,
    size_t len,
    int prot) {
  (void)addr;
  (void)len;
  (void)prot;
  errno = ENOTSUP;
  return -1;
}
#endif

enum {
  ELIZA_DEFAULT_CALL_TIMEOUT_MS = 120000,
  ELIZA_MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000,
  ELIZA_MAX_STARTUP_TIMEOUT_MS = 10 * 60 * 1000,
  ELIZA_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024,
  ELIZA_LAST_ERROR_BYTES = 4096,
  ELIZA_READ_BLOCK_BYTES = 64 * 1024,
  ELIZA_POLL_SLICE_MS = 250,
  ELIZA_PREVIOUS_EXIT_WAIT_MS = 5000,
};

// Lock order: g_lifecycle_mutex, then g_write_mutex, then g_state_mutex.
// g_state_mutex guards the run state, the fd and stdio globals and the
// pending-call list; g_state_cond is broadcast whenever any of them changes.
static pthread_mutex_t g_lifecycle_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_write_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_error_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_state_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_state_cond = PTHREAD_COND_INITIALIZER;
static pthread_mutex_t g_host_callback_mutex = PTHREAD_MUTEX_INITIALIZER;
static int g_running = 0;
static int g_starting = 0;
static int g_stopping = 0;
static uint64_t g_next_id = 1;
// Each start is one run. Callbacks and threads carry the run they belong to
// and ignore themselves once a newer run has begun.
static uint64_t g_run_generation = 0;
// The run whose Bun has not exited yet, or 0. Bun is one per process, so a new
// run cannot begin until this clears.
static uint64_t g_bun_live_generation = 0;
static int g_ready_state = 0;
static char *g_ready_error = NULL;
static int g_reader_done = 0;
static int g_stdin_read_fd = -1;
static int g_stdin_write_fd = -1;
static int g_stdout_read_fd = -1;
static int g_stdout_write_fd = -1;
static int g_stderr_read_fd = -1;
static int g_stderr_write_fd = -1;
static int g_saved_stdin_fd = -1;
static int g_saved_stdout_fd = -1;
static int g_saved_stderr_fd = -1;
static pthread_t g_reader_thread;
static int g_reader_thread_started = 0;
static pthread_t g_stderr_thread;
static int g_stderr_thread_started = 0;
static int g_stderr_thread_stop = 0;
static int g_bun_exited = 0;
static uint32_t g_bun_exit_code = 0;
static eliza_bun_engine_host_call_callback g_host_callback = NULL;
static char g_last_error[ELIZA_LAST_ERROR_BYTES] = {0};

typedef struct pending_call {
  uint64_t id;
  char *response;
  int done;
  struct pending_call *next;
} pending_call_t;

static pending_call_t *g_pending_calls = NULL;

static void close_fd(int *fd);
static void restore_stdio(void);
static void set_last_error(const char *fmt, ...);
static void debug_log(const char *fmt, ...);
static const char *find_json_field_value(const char *json, const char *field);
static void free_argv(char **argv, int argc);

typedef struct {
  int argc;
  char **args;
  uint64_t generation;
  int stdin_read_fd;
  int stdout_write_fd;
  int stderr_write_fd;
} bun_start_thread_args_t;

// Records that the Bun of `generation` is gone. Only the current run's output
// pipes and stdio are touched; an exit from an earlier run changes nothing.
// Caller holds g_state_mutex. Returns 1 when the exit belonged to the current
// run and 2 when that run had reached readiness.
static int record_bun_exit_locked(uint64_t generation, uint32_t code) {
  if (generation == 0) return 0;
  if (g_bun_live_generation == generation) g_bun_live_generation = 0;
  pthread_cond_broadcast(&g_state_cond);
  if (generation != g_run_generation) return 0;
  int was_running = g_running;
  g_bun_exited = 1;
  g_bun_exit_code = code;
  g_running = 0;
  restore_stdio();
  close_fd(&g_stdin_read_fd);
  close_fd(&g_stdout_write_fd);
  close_fd(&g_stderr_write_fd);
  return was_running ? 2 : 1;
}

static void on_bun_exit(uint32_t code) {
  pthread_mutex_lock(&g_state_mutex);
  int current = record_bun_exit_locked(g_bun_live_generation, code);
  pthread_mutex_unlock(&g_state_mutex);
  if (current == 0) {
    debug_log("ignoring exit code=%u from an earlier Bun run", code);
    return;
  }
  set_last_error(
      current == 2 ? "Bun exited with code %u"
                   : "Bun exited before ios-bridge readiness with code %u",
      code);
}

static void close_fd(int *fd) {
  if (*fd >= 0) {
    close(*fd);
    *fd = -1;
  }
}

static int redirect_stdio_to_bridge(
    int stdin_read_fd,
    int stdout_write_fd,
    int stderr_write_fd) {
  if (g_saved_stdin_fd >= 0 || g_saved_stdout_fd >= 0 || g_saved_stderr_fd >= 0) {
    return 0;
  }

  g_saved_stdin_fd = dup(STDIN_FILENO);
  g_saved_stdout_fd = dup(STDOUT_FILENO);
  g_saved_stderr_fd = dup(STDERR_FILENO);
  if (g_saved_stdin_fd < 0 || g_saved_stdout_fd < 0 || g_saved_stderr_fd < 0) {
    set_last_error("failed to save process stdio before Bun start: %s", strerror(errno));
    restore_stdio();
    return -1;
  }

  if (dup2(stdin_read_fd, STDIN_FILENO) < 0 ||
      dup2(stdout_write_fd, STDOUT_FILENO) < 0 ||
      dup2(stderr_write_fd, STDERR_FILENO) < 0) {
    set_last_error("failed to bind Bun stdio to bridge pipes: %s", strerror(errno));
    restore_stdio();
    return -1;
  }
  return 0;
}

static void restore_stdio(void) {
  if (g_saved_stdin_fd >= 0) {
    dup2(g_saved_stdin_fd, STDIN_FILENO);
    close_fd(&g_saved_stdin_fd);
  }
  if (g_saved_stdout_fd >= 0) {
    dup2(g_saved_stdout_fd, STDOUT_FILENO);
    close_fd(&g_saved_stdout_fd);
  }
  if (g_saved_stderr_fd >= 0) {
    dup2(g_saved_stderr_fd, STDERR_FILENO);
    close_fd(&g_saved_stderr_fd);
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

// The log goes to a private copy of the process stderr taken before Bun's
// stdio is redirected, so it never lands in the bridge pipes.
static pthread_once_t g_log_once = PTHREAD_ONCE_INIT;
static int g_log_fd = STDERR_FILENO;

static void init_log_fd(void) {
  int fd = dup(STDERR_FILENO);
  if (fd >= 0) g_log_fd = fd;
}

static void debug_log(const char *fmt, ...) {
  pthread_once(&g_log_once, init_log_fd);
  int fd = g_log_fd;
  va_list args;
  va_start(args, fmt);
  dprintf(fd, "[ElizaBunEngine] ");
  vdprintf(fd, fmt, args);
  dprintf(fd, "\n");
  va_end(args);
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

static int parse_hex4(const char *p, uint32_t *out) {
  uint32_t value = 0;
  for (int i = 0; i < 4; i++) {
    char ch = p[i];
    value <<= 4;
    if (ch >= '0' && ch <= '9') {
      value |= (uint32_t)(ch - '0');
    } else if (ch >= 'a' && ch <= 'f') {
      value |= (uint32_t)(ch - 'a' + 10);
    } else if (ch >= 'A' && ch <= 'F') {
      value |= (uint32_t)(ch - 'A' + 10);
    } else {
      return -1;
    }
  }
  *out = value;
  return 0;
}

static size_t encode_utf8(uint32_t cp, char *out) {
  if (cp < 0x80) {
    out[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18));
  out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

// Parses one JSON string at *cursor and returns it decoded as UTF-8, with
// \uXXXX escapes (and surrogate pairs) expanded; a lone surrogate becomes
// U+FFFD. Returns NULL for an unterminated string, a malformed escape or an
// embedded NUL, so a truncated frame is never read past its terminator.
static char *parse_json_string(const char **cursor) {
  const char *p = skip_ws(*cursor);
  if (*p != '"') return NULL;
  p++;
  size_t cap = 32;
  size_t len = 0;
  char *out = (char *)malloc(cap);
  if (!out) return NULL;
  for (;;) {
    char ch = *p;
    if (ch == '\0') {
      free(out);
      return NULL;
    }
    if (ch == '"') {
      p++;
      break;
    }
    p++;
    char decoded[4];
    size_t decoded_len = 1;
    decoded[0] = ch;
    if (ch == '\\') {
      char esc = *p;
      if (esc == '\0') {
        free(out);
        return NULL;
      }
      p++;
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          decoded[0] = esc;
          break;
        case 'n':
          decoded[0] = '\n';
          break;
        case 'r':
          decoded[0] = '\r';
          break;
        case 't':
          decoded[0] = '\t';
          break;
        case 'b':
          decoded[0] = '\b';
          break;
        case 'f':
          decoded[0] = '\f';
          break;
        case 'u': {
          uint32_t cp = 0;
          if (parse_hex4(p, &cp) != 0) {
            free(out);
            return NULL;
          }
          p += 4;
          if (cp >= 0xD800 && cp <= 0xDBFF) {
            uint32_t low = 0;
            if (p[0] == '\\' && p[1] == 'u' && parse_hex4(p + 2, &low) == 0 &&
                low >= 0xDC00 && low <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
              p += 6;
            } else {
              cp = 0xFFFD;
            }
          } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            cp = 0xFFFD;
          }
          if (cp == 0) {
            free(out);
            return NULL;
          }
          decoded_len = encode_utf8(cp, decoded);
          break;
        }
        default:
          free(out);
          return NULL;
      }
    }
    if (len + decoded_len + 1 > cap) {
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
    memcpy(out + len, decoded, decoded_len);
    len += decoded_len;
  }
  out[len] = '\0';
  *cursor = p;
  return out;
}

static int is_forbidden_env_key(const char *key) {
  if (!key || key[0] == '\0') return 1;
  if (strncmp(key, "DYLD_", 5) == 0) return 1;
  if (strncmp(key, "BUN_JSC_", 8) == 0) return 1;
  return strcmp(key, "NODE_OPTIONS") == 0 ||
      strcmp(key, "BUN_OPTIONS") == 0 ||
      strcmp(key, "BUN_PRELOAD") == 0 ||
      strcmp(key, "JSC_useJIT") == 0 ||
      strcmp(key, "JSC_jitPolicyScale") == 0 ||
      strcmp(key, "MallocStackLogging") == 0 ||
      strcmp(key, "MallocStackLoggingNoCompact") == 0;
}

static void apply_app_store_runtime_env(void) {
  setenv("ELIZA_IOS_APP_STORE_LOCAL_EXECUTION", "1", 1);
  setenv("ELIZA_IOS_NO_JIT", "1", 1);
  setenv("JSC_useJIT", "0", 1);
  setenv("JSC_jitPolicyScale", "0", 1);
  setenv("BUN_JSC_useJIT", "0", 1);
  unsetenv("NODE_OPTIONS");
  unsetenv("BUN_OPTIONS");
  unsetenv("BUN_PRELOAD");
  unsetenv("DYLD_INSERT_LIBRARIES");
  unsetenv("DYLD_LIBRARY_PATH");
  unsetenv("DYLD_FRAMEWORK_PATH");
}

typedef void (*env_pair_fn)(const char *key, const char *value, int is_string, void *ctx);

// Walks a flat JSON object and reports each pair whose key passes
// is_forbidden_env_key. Stops at the first malformed token.
static void for_each_safe_env_pair(const char *json, env_pair_fn fn, void *ctx) {
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
    int is_string = *p == '"';
    if (is_string) {
      value = parse_json_string(&p);
      if (!value) {
        free(key);
        return;
      }
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
    if (value && !is_forbidden_env_key(key)) fn(key, value, is_string, ctx);
    free(key);
    free(value);
    p = skip_ws(p);
    if (*p == ',') p++;
  }
}

static void setenv_pair(const char *key, const char *value, int is_string, void *ctx) {
  (void)is_string;
  (void)ctx;
  setenv(key, value, 1);
}

static void apply_safe_env_json(const char *json) {
  for_each_safe_env_pair(json, setenv_pair, NULL);
}

typedef struct {
  char *data;
  size_t len;
  size_t cap;
  int failed;
} string_builder_t;

static void sb_append(string_builder_t *sb, const char *text) {
  if (sb->failed) return;
  size_t add = strlen(text);
  if (sb->len + add + 1 > sb->cap) {
    size_t cap = sb->cap ? sb->cap : 64;
    while (sb->len + add + 1 > cap) cap *= 2;
    char *grown = (char *)realloc(sb->data, cap);
    if (!grown) {
      sb->failed = 1;
      return;
    }
    sb->data = grown;
    sb->cap = cap;
  }
  memcpy(sb->data + sb->len, text, add + 1);
  sb->len += add;
}

static void append_env_pair(const char *key, const char *value, int is_string, void *ctx) {
  // The bridge hydrates only string values from argv, so others are dropped.
  if (!is_string) return;
  string_builder_t *sb = (string_builder_t *)ctx;
  char *escaped_key = json_escape(key);
  char *escaped_value = json_escape(value);
  if (!escaped_key || !escaped_value) {
    sb->failed = 1;
  } else {
    if (sb->len > 1) sb_append(sb, ",");
    sb_append(sb, escaped_key);
    sb_append(sb, ":");
    sb_append(sb, escaped_value);
  }
  free(escaped_key);
  free(escaped_value);
}

// Re-serializes the env JSON with only the keys apply_safe_env_json accepts,
// so the copy the bridge reads from argv cannot reintroduce a filtered key.
static char *filter_env_json(const char *json) {
  string_builder_t sb = {0};
  sb_append(&sb, "{");
  for_each_safe_env_pair(json, append_env_pair, &sb);
  sb_append(&sb, "}");
  if (sb.failed) {
    free(sb.data);
    return NULL;
  }
  return sb.data;
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
    setenv("ELIZA_STATE_DIR", app_support_dir, 1);
    char *workspace_dir = join_path_dup(app_support_dir, "workspace");
    if (workspace_dir) {
      mkdir(workspace_dir, 0700);
      setenv("ELIZA_WORKSPACE_DIR", workspace_dir, 1);
      setenv("MOBILE_WORKSPACE_ROOT", app_support_dir, 1);
      free(workspace_dir);
    } else {
      setenv("ELIZA_WORKSPACE_DIR", app_support_dir, 1);
      setenv("MOBILE_WORKSPACE_ROOT", app_support_dir, 1);
    }
    char *pglite_dir = join_path_dup(app_support_dir, ".elizadb");
    if (pglite_dir) {
      setenv("PGLITE_DATA_DIR", pglite_dir, 1);
      free(pglite_dir);
    }
  }
  if (bundle_path && bundle_path[0]) {
    setenv("ELIZA_IOS_AGENT_BUNDLE", bundle_path, 1);
    char *asset_dir = dirname_dup(bundle_path);
    if (asset_dir) {
      setenv("ELIZA_IOS_AGENT_ASSET_DIR", asset_dir, 1);
      char *public_dir = dirname_dup(asset_dir);
      if (public_dir) {
        setenv("ELIZA_IOS_AGENT_PUBLIC_DIR", public_dir, 1);
        free(public_dir);
      }
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
  setenv("ELIZA_IOS_BRIDGE_TRANSPORT", "bun-host-ipc", 0);
  setenv("LOG_LEVEL", "error", 0);
  setenv("GIGACAGE_ENABLED", "0", 0);
  apply_app_store_runtime_env();
}

enum {
  ELIZA_WRITE_OK = 0,
  ELIZA_WRITE_ERROR = -1,
  ELIZA_WRITE_TIMEOUT = -2,
  ELIZA_WRITE_STALE = -3,
};

static int g_stream_failed = 0;

// A frame written only part way leaves the request pipe out of step with the
// bridge's line reader, so the run cannot carry another frame. Marking it
// failed makes is_running report 0 and the host restarts the engine.
static void mark_stream_failed(uint64_t generation, const char *reason) {
  pthread_mutex_lock(&g_state_mutex);
  int current = generation == g_run_generation;
  if (current) {
    g_stream_failed = 1;
    g_running = 0;
    pthread_cond_broadcast(&g_state_cond);
  }
  pthread_mutex_unlock(&g_state_mutex);
  if (current) set_last_error("%s", reason);
}

// Writes one frame to the run's request pipe, which is non-blocking. Waits for
// room in slices so stop can close the pipe, and gives up at the deadline.
static int write_frame(uint64_t generation, const char *data, size_t len, int64_t deadline) {
  pthread_mutex_lock(&g_write_mutex);
  size_t written = 0;
  int result = ELIZA_WRITE_OK;
  while (written < len) {
    pthread_mutex_lock(&g_state_mutex);
    int fd = generation == g_run_generation && !g_stopping && !g_stream_failed
        ? g_stdin_write_fd
        : -1;
    pthread_mutex_unlock(&g_state_mutex);
    if (fd < 0) {
      errno = EPIPE;
      result = ELIZA_WRITE_STALE;
      break;
    }
    ssize_t n = write(fd, data + written, len - written);
    if (n > 0) {
      written += (size_t)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      int64_t remaining = deadline - monotonic_ms();
      if (remaining <= 0) {
        errno = ETIMEDOUT;
        result = ELIZA_WRITE_TIMEOUT;
        break;
      }
      struct pollfd pfd = {fd, POLLOUT, 0};
      poll(&pfd, 1, remaining > ELIZA_POLL_SLICE_MS ? ELIZA_POLL_SLICE_MS : (int)remaining);
      continue;
    }
    if (n == 0) errno = EPIPE;
    result = ELIZA_WRITE_ERROR;
    break;
  }
  int saved_errno = errno;
  pthread_mutex_unlock(&g_write_mutex);
  if (result != ELIZA_WRITE_OK && written > 0) {
    mark_stream_failed(generation, "Bun bridge request pipe stopped part way through a frame");
  }
  errno = saved_errno;
  return result;
}

// Bytes read from the bridge's stdout, kept across reads so a frame that
// arrives in pieces is joined instead of dropped.
typedef struct {
  char *data;
  size_t len;
  size_t cap;
  size_t scanned;
} line_buffer_t;

static int line_buffer_append(line_buffer_t *buf, const char *bytes, size_t n) {
  size_t needed = buf->len + n + 1;
  if (needed > buf->cap) {
    size_t cap = buf->cap ? buf->cap : 4096;
    while (cap < needed) cap *= 2;
    char *grown = (char *)realloc(buf->data, cap);
    if (!grown) return -1;
    buf->data = grown;
    buf->cap = cap;
  }
  memcpy(buf->data + buf->len, bytes, n);
  buf->len += n;
  buf->data[buf->len] = '\0';
  return 0;
}

// Removes and returns the next complete line without its newline or trailing
// CR, or NULL when no full line is buffered. Sets *overflow when a line is
// longer than the protocol allows.
static char *line_buffer_take_line(line_buffer_t *buf, int *overflow) {
  *overflow = 0;
  char *newline = buf->len > buf->scanned
      ? (char *)memchr(buf->data + buf->scanned, '\n', buf->len - buf->scanned)
      : NULL;
  if (!newline) {
    buf->scanned = buf->len;
    if (buf->len > ELIZA_MAX_PROTOCOL_LINE_BYTES) *overflow = 1;
    return NULL;
  }
  size_t line_len = (size_t)(newline - buf->data);
  size_t keep = line_len;
  if (keep > 0 && buf->data[keep - 1] == '\r') keep--;
  if (keep > ELIZA_MAX_PROTOCOL_LINE_BYTES) {
    *overflow = 1;
    return NULL;
  }
  char *line = (char *)malloc(keep + 1);
  if (!line) {
    *overflow = 1;
    return NULL;
  }
  memcpy(line, buf->data, keep);
  line[keep] = '\0';
  size_t rest = buf->len - line_len - 1;
  memmove(buf->data, newline + 1, rest);
  buf->len = rest;
  buf->data[rest] = '\0';
  buf->scanned = 0;
  return line;
}

static void line_buffer_free(line_buffer_t *buf) {
  free(buf->data);
  buf->data = NULL;
  buf->len = 0;
  buf->cap = 0;
  buf->scanned = 0;
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
  const char *p = find_json_field_value(json, field);
  if (!p || *p != '"') return NULL;
  return parse_json_string(&p);
}

static const char *find_json_field_value(const char *json, const char *field) {
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
  return p;
}

static char *extract_json_value_field(const char *json, const char *field) {
  const char *p = find_json_field_value(json, field);
  if (!p) return NULL;
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

static int service_host_call_line(uint64_t generation, const char *line) {
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

  int write_result = write_frame(
      generation,
      response,
      strlen(response),
      monotonic_ms() + ELIZA_DEFAULT_CALL_TIMEOUT_MS);
  int write_errno = errno;
  free(call_id);
  free(method);
  free(payload);
  free(envelope);
  free(escaped_id);
  free(response);
  if (write_result == ELIZA_WRITE_STALE) {
    debug_log("dropping host_result for a stopped Bun run");
    return 0;
  }
  if (write_result != ELIZA_WRITE_OK) {
    set_last_error("failed to write native host_result to Bun bridge: %s", strerror(write_errno));
    return -1;
  }
  return 0;
}

typedef struct {
  uint64_t generation;
  char *line;
} host_call_job_t;

static void *host_call_thread(void *raw_arg) {
  host_call_job_t *job = (host_call_job_t *)raw_arg;
  service_host_call_line(job->generation, job->line);
  free(job->line);
  free(job);
  return NULL;
}

// Host calls run on their own thread so a long one (llama_generate) does not
// hold up responses, llama_cancel, or the next stream_emit. The bridge awaits
// each stream_emit before sending the next, so token order is kept.
static void dispatch_host_call(uint64_t generation, char *line) {
  host_call_job_t *job = (host_call_job_t *)malloc(sizeof(host_call_job_t));
  if (job) {
    job->generation = generation;
    job->line = line;
    pthread_attr_t attr;
    pthread_t thread;
    int created = pthread_attr_init(&attr) == 0;
    if (created) {
      pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
      created = pthread_create(&thread, &attr, host_call_thread, job) == 0;
      pthread_attr_destroy(&attr);
    }
    if (created) return;
    free(job);
  }
  service_host_call_line(generation, line);
  free(line);
}

// Routes one line from the bridge: host calls to a worker, the ready frame to
// the start that waits for it, and responses to the call waiting on that id.
static void dispatch_protocol_line(uint64_t generation, char *line) {
  if (is_host_call_line(line) && extract_line_id(line) < 0) {
    dispatch_host_call(generation, line);
    return;
  }
  pthread_mutex_lock(&g_state_mutex);
  if (generation != g_run_generation) {
    pthread_mutex_unlock(&g_state_mutex);
    free(line);
    return;
  }
  int before_ready = g_ready_state == 0;
  if (before_ready) {
    char *ready_error = NULL;
    int ready = is_ready_line(line, &ready_error);
    if (ready != 0) {
      g_ready_state = ready;
      free(g_ready_error);
      g_ready_error = ready_error;
      pthread_cond_broadcast(&g_state_cond);
      pthread_mutex_unlock(&g_state_mutex);
      free(line);
      return;
    }
  }
  int64_t id = extract_line_id(line);
  if (id >= 0) {
    for (pending_call_t *call = g_pending_calls; call; call = call->next) {
      if (call->id == (uint64_t)id && !call->done) {
        call->response = line;
        call->done = 1;
        pthread_cond_broadcast(&g_state_cond);
        pthread_mutex_unlock(&g_state_mutex);
        return;
      }
    }
  }
  pthread_mutex_unlock(&g_state_mutex);
  if (before_ready) debug_log("stdout before ready: %.512s", line);
  free(line);
}

typedef struct {
  int fd;
  uint64_t generation;
} reader_thread_args_t;

// The one reader of the bridge's stdout for a run. It reads in blocks, keeps
// partial frames between reads, and dispatches every complete line whether or
// not a native call is waiting.
static void *protocol_reader_thread(void *raw_arg) {
  reader_thread_args_t args = *(reader_thread_args_t *)raw_arg;
  free(raw_arg);
  line_buffer_t buf = {0};
  char *block = (char *)malloc(ELIZA_READ_BLOCK_BYTES);
  const char *failure = block ? NULL : "out of memory while reading Bun bridge output";
  while (!failure) {
    pthread_mutex_lock(&g_state_mutex);
    int stop = g_stopping || args.generation != g_run_generation;
    pthread_mutex_unlock(&g_state_mutex);
    if (stop) break;
    struct pollfd pfd = {args.fd, POLLIN, 0};
    int ready = poll(&pfd, 1, ELIZA_POLL_SLICE_MS);
    if (ready < 0) {
      if (errno == EINTR) continue;
      failure = "failed to poll Bun bridge output";
      break;
    }
    if (ready == 0) continue;
    ssize_t n = read(args.fd, block, ELIZA_READ_BLOCK_BYTES);
    if (n < 0) {
      if (errno == EINTR || errno == EAGAIN) continue;
      failure = "failed to read Bun bridge output";
      break;
    }
    if (n == 0) break;
    if (line_buffer_append(&buf, block, (size_t)n) != 0) {
      failure = "out of memory while reading Bun bridge output";
      break;
    }
    for (;;) {
      int overflow = 0;
      char *line = line_buffer_take_line(&buf, &overflow);
      if (overflow) {
        failure = "Bun bridge protocol line exceeded the size limit";
        break;
      }
      if (!line) break;
      dispatch_protocol_line(args.generation, line);
    }
  }
  free(block);
  line_buffer_free(&buf);
  if (failure) set_last_error("%s", failure);
  pthread_mutex_lock(&g_state_mutex);
  if (args.generation == g_run_generation) g_reader_done = 1;
  pthread_cond_broadcast(&g_state_cond);
  pthread_mutex_unlock(&g_state_mutex);
  return NULL;
}

static int start_protocol_reader(int fd, uint64_t generation) {
  reader_thread_args_t *args = (reader_thread_args_t *)malloc(sizeof(reader_thread_args_t));
  if (!args) return -1;
  args->fd = fd;
  args->generation = generation;
  if (pthread_create(&g_reader_thread, NULL, protocol_reader_thread, args) != 0) {
    free(args);
    return -1;
  }
  pthread_mutex_lock(&g_state_mutex);
  g_reader_thread_started = 1;
  pthread_mutex_unlock(&g_state_mutex);
  return 0;
}

static void *stderr_drain_thread(void *arg) {
  int fd = *(int *)arg;
  free(arg);
  char buffer[1024];
  while (!__atomic_load_n(&g_stderr_thread_stop, __ATOMIC_ACQUIRE)) {
    struct pollfd pfd = {fd, POLLIN, 0};
    int ready = poll(&pfd, 1, ELIZA_POLL_SLICE_MS);
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
    if (n > 0) debug_log("stderr: %s", buffer);
  }
  return NULL;
}

static int start_stderr_drain(int fd) {
  int *arg = (int *)malloc(sizeof(int));
  if (!arg) return -1;
  *arg = fd;
  __atomic_store_n(&g_stderr_thread_stop, 0, __ATOMIC_RELEASE);
  if (pthread_create(&g_stderr_thread, NULL, stderr_drain_thread, arg) != 0) {
    free(arg);
    return -1;
  }
  g_stderr_thread_started = 1;
  return 0;
}

// Joins the drain thread before closing the fd it polls, so the fd number is
// never reused under it.
static void stop_stderr_drain(void) {
  __atomic_store_n(&g_stderr_thread_stop, 1, __ATOMIC_RELEASE);
  if (g_stderr_thread_started) {
    pthread_join(g_stderr_thread, NULL);
    g_stderr_thread_started = 0;
  }
  pthread_mutex_lock(&g_state_mutex);
  close_fd(&g_stderr_read_fd);
  pthread_mutex_unlock(&g_state_mutex);
}

static void *bun_start_thread(void *raw_arg) {
  bun_start_thread_args_t *thread_args = (bun_start_thread_args_t *)raw_arg;
  if (!thread_args) return NULL;
  debug_log("bun_start thread starting argc=%d", thread_args->argc);
  int result = bun_start(
      thread_args->argc,
      (const char **)thread_args->args,
      thread_args->stdin_read_fd,
      thread_args->stdout_write_fd,
      thread_args->stderr_write_fd,
      on_bun_exit);
  debug_log("bun_start returned code=%d", result);
  if (result != 0) {
    pthread_mutex_lock(&g_state_mutex);
    int current = record_bun_exit_locked(thread_args->generation, (uint32_t)result);
    pthread_mutex_unlock(&g_state_mutex);
    if (current) set_last_error("bun_start failed with code %d", result);
  }
  free_argv(thread_args->args, thread_args->argc);
  free(thread_args);
  return NULL;
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

static int has_suffix(const char *value, const char *suffix) {
  size_t value_len = strlen(value);
  size_t suffix_len = strlen(suffix);
  return value_len >= suffix_len &&
      strcmp(value + value_len - suffix_len, suffix) == 0;
}

// Returns the positional argument naming a .js or .mjs script, skipping
// options and the values they take, or -1 when there is none (the bundle is
// then inserted rather than overwriting a subcommand such as ios-bridge).
static int find_script_arg_index(char **argv, int argc) {
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (!arg || arg[0] == '\0') continue;
    if (arg[0] == '-') {
      if (option_consumes_value(arg)) i++;
      continue;
    }
    if (has_suffix(arg, ".js") || has_suffix(arg, ".mjs")) return i;
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

  char *bundle = xstrdup(bundle_path);
  if (!bundle) return -1;
  char **grown = (char **)realloc(argv, (size_t)(argc + 1) * sizeof(char *));
  if (!grown) {
    free(bundle);
    return -1;
  }
  argv = grown;
  for (int i = argc; i > insert_at; i--) argv[i] = argv[i - 1];
  argv[insert_at] = bundle;
  *argv_inout = argv;
  *argc_inout = argc + 1;
  return 0;
}

static int append_arg(char ***argv_inout, int *argc_inout, const char *value) {
  char **argv = *argv_inout;
  int argc = *argc_inout;
  char *copy = xstrdup(value ? value : "");
  if (!copy) return -1;
  char **grown = (char **)realloc(argv, (size_t)(argc + 1) * sizeof(char *));
  if (!grown) {
    free(copy);
    return -1;
  }
  argv = grown;
  argv[argc] = copy;
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

static int append_ios_env_args(
    char ***argv_inout,
    int *argc_inout,
    const char *env_json,
    const char *app_support_dir,
    const char *bundle_path) {
  if (env_json && env_json[0]) {
    char *filtered_env = filter_env_json(env_json);
    if (!filtered_env) return -1;
    int failed = append_arg(argv_inout, argc_inout, "--eliza-ios-env-json") != 0 ||
        append_arg(argv_inout, argc_inout, filtered_env) != 0;
    free(filtered_env);
    if (failed) return -1;
  }
  if (app_support_dir && app_support_dir[0]) {
    if (append_arg(argv_inout, argc_inout, "--eliza-ios-app-support-dir") != 0 ||
        append_arg(argv_inout, argc_inout, app_support_dir) != 0) {
      return -1;
    }
  }
  if (bundle_path && bundle_path[0]) {
    if (append_arg(argv_inout, argc_inout, "--eliza-ios-agent-bundle") != 0 ||
        append_arg(argv_inout, argc_inout, bundle_path) != 0) {
      return -1;
    }
  }
  return 0;
}

// Waits on g_state_cond for at most a second and never past the monotonic
// deadline; callers re-check their condition. Caller holds g_state_mutex.
// Returns 0 once the deadline has passed.
static int wait_state_until(int64_t deadline) {
  int64_t remaining = deadline - monotonic_ms();
  if (remaining <= 0) return 0;
  if (remaining > 1000) remaining = 1000;
  struct timeval now;
  gettimeofday(&now, NULL);
  int64_t nsec = (int64_t)now.tv_usec * 1000 + (remaining % 1000) * 1000000;
  struct timespec until;
  until.tv_sec = now.tv_sec + (time_t)(remaining / 1000) + (time_t)(nsec / 1000000000);
  until.tv_nsec = (long)(nsec % 1000000000);
  pthread_cond_timedwait(&g_state_cond, &g_state_mutex, &until);
  return 1;
}

static int wait_for_ready(uint64_t generation, int timeout_ms) {
  int64_t deadline = monotonic_ms() + timeout_ms;
  int result = -1;
  int exit_code = 0;
  char *ready_error = NULL;
  enum { WAIT_READY, WAIT_STOPPED, WAIT_FAILED, WAIT_EXITED, WAIT_STREAM, WAIT_CLOSED, WAIT_TIMEOUT } reason;
  pthread_mutex_lock(&g_state_mutex);
  for (;;) {
    if (generation != g_run_generation || g_stopping) {
      reason = WAIT_STOPPED;
      break;
    }
    if (g_ready_state > 0) {
      reason = WAIT_READY;
      result = 0;
      break;
    }
    if (g_ready_state < 0) {
      reason = WAIT_FAILED;
      ready_error = g_ready_error;
      g_ready_error = NULL;
      break;
    }
    if (g_bun_exited) {
      reason = WAIT_EXITED;
      exit_code = (int)g_bun_exit_code;
      break;
    }
    if (g_stream_failed) {
      reason = WAIT_STREAM;
      break;
    }
    if (g_reader_done) {
      reason = WAIT_CLOSED;
      break;
    }
    if (!wait_state_until(deadline)) {
      reason = WAIT_TIMEOUT;
      result = -2;
      break;
    }
  }
  pthread_mutex_unlock(&g_state_mutex);

  switch (reason) {
    case WAIT_READY:
    case WAIT_STREAM:
      break;
    case WAIT_STOPPED:
      set_last_error("ElizaBunEngine was stopped before ios-bridge readiness");
      break;
    case WAIT_FAILED:
      set_last_error(
          "ios-bridge readiness failed: %s",
          ready_error ? ready_error : "unknown error");
      break;
    case WAIT_EXITED:
      set_last_error("Bun exited before ios-bridge readiness with code %u", (uint32_t)exit_code);
      break;
    case WAIT_CLOSED: {
      pthread_mutex_lock(&g_error_mutex);
      int has_error = g_last_error[0] != '\0';
      pthread_mutex_unlock(&g_error_mutex);
      if (!has_error) set_last_error("ios-bridge closed before readiness");
      break;
    }
    case WAIT_TIMEOUT:
      set_last_error("ios-bridge did not become ready within %dms", timeout_ms);
      break;
  }
  free(ready_error);
  return result;
}

// Closes the run's pipes, puts stdio back, and joins the reader and stderr
// threads. Safe to call repeatedly; callers hold g_lifecycle_mutex.
static void release_run_resources(void) {
  pthread_mutex_lock(&g_state_mutex);
  g_stopping = 1;
  g_running = 0;
  pthread_cond_broadcast(&g_state_cond);
  pthread_mutex_unlock(&g_state_mutex);

  // Writers poll in short slices and re-check g_stopping, so this lock is
  // released quickly even when the pipe is full.
  pthread_mutex_lock(&g_write_mutex);
  pthread_mutex_lock(&g_state_mutex);
  close_fd(&g_stdin_write_fd);
  pthread_mutex_unlock(&g_state_mutex);
  pthread_mutex_unlock(&g_write_mutex);

  pthread_mutex_lock(&g_state_mutex);
  restore_stdio();
  // The pipe ends Bun was handed stay open until its exit is recorded, so a
  // Bun that is still shutting down never reads or writes a reused fd.
  if (g_bun_live_generation == 0) {
    close_fd(&g_stdin_read_fd);
    close_fd(&g_stdout_write_fd);
    close_fd(&g_stderr_write_fd);
  }
  int join_reader = g_reader_thread_started;
  g_reader_thread_started = 0;
  pthread_mutex_unlock(&g_state_mutex);
  if (join_reader) pthread_join(g_reader_thread, NULL);
  pthread_mutex_lock(&g_state_mutex);
  close_fd(&g_stdout_read_fd);
  pthread_mutex_unlock(&g_state_mutex);
  stop_stderr_drain();
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
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
  pthread_once(&g_log_once, init_log_fd);
  pthread_mutex_lock(&g_state_mutex);
  if (g_running && !g_bun_exited && !g_reader_done && !g_stream_failed) {
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

  pthread_mutex_lock(&g_lifecycle_mutex);
  // A previous run that exited or failed still owns pipes and threads; release
  // them before the globals are reused. Closing its request pipe also lets a
  // still-live bridge see stdin end and exit.
  release_run_resources();

  pthread_mutex_lock(&g_state_mutex);
  int64_t exit_deadline = monotonic_ms() + ELIZA_PREVIOUS_EXIT_WAIT_MS;
  while (g_bun_live_generation != 0 && wait_state_until(exit_deadline)) {
  }
  if (g_bun_live_generation != 0) {
    g_starting = 0;
    pthread_mutex_unlock(&g_state_mutex);
    pthread_mutex_unlock(&g_lifecycle_mutex);
    set_last_error("the previous Bun run has not exited yet");
    return -3;
  }
  uint64_t generation = ++g_run_generation;
  g_stopping = 0;
  g_ready_state = 0;
  free(g_ready_error);
  g_ready_error = NULL;
  g_reader_done = 0;
  g_stream_failed = 0;
  g_bun_exited = 0;
  g_bun_exit_code = 0;
  pthread_mutex_unlock(&g_state_mutex);

  set_last_error("");
  int argc = 0;
  char **args = NULL;
  int stdin_pipe[2] = {-1, -1};
  int stdout_pipe[2] = {-1, -1};
  int stderr_pipe[2] = {-1, -1};
  int redirected = -1;
  bun_start_thread_args_t *thread_args = NULL;
  pthread_t bun_thread;
  int startup_timeout_ms = 0;
  int ready = -1;
  if (!bundle_path || bundle_path[0] == '\0') {
    set_last_error("bundle_path is required");
    goto fail;
  }

  if (pipe(stdin_pipe) != 0 || pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0) {
    set_last_error("failed to create bridge pipes: %s", strerror(errno));
  }
  pthread_mutex_lock(&g_state_mutex);
  g_stdin_read_fd = stdin_pipe[0];
  g_stdin_write_fd = stdin_pipe[1];
  g_stdout_read_fd = stdout_pipe[0];
  g_stdout_write_fd = stdout_pipe[1];
  g_stderr_read_fd = stderr_pipe[0];
  g_stderr_write_fd = stderr_pipe[1];
  pthread_mutex_unlock(&g_state_mutex);
  if (stderr_pipe[1] < 0) goto fail;
  if (set_nonblocking(stdin_pipe[1]) != 0) {
    set_last_error("failed to make the Bun request pipe non-blocking: %s", strerror(errno));
    goto fail;
  }

  apply_safe_env_json(env_json);
  ensure_default_env(app_support_dir, bundle_path);
  debug_log("start requested bundle=%s appSupport=%s", bundle_path, app_support_dir);

  args = parse_argv_json(argv_json, bundle_path, &argc);
  if (
      !args || argc <= 0 ||
      append_ios_env_args(&args, &argc, env_json, app_support_dir, bundle_path) != 0) {
    set_last_error("failed to parse argv JSON for Bun engine");
    goto fail;
  }

  pthread_mutex_lock(&g_state_mutex);
  redirected = redirect_stdio_to_bridge(stdin_pipe[0], stdout_pipe[1], stderr_pipe[1]);
  pthread_mutex_unlock(&g_state_mutex);
  if (redirected != 0) goto fail;
  debug_log("stdio redirected; starting Bun thread");

  if (start_stderr_drain(stderr_pipe[0]) != 0) {
    set_last_error("failed to start stderr drain thread");
    goto fail;
  }
  if (start_protocol_reader(stdout_pipe[0], generation) != 0) {
    set_last_error("failed to start Bun bridge reader thread");
    goto fail;
  }

  thread_args = (bun_start_thread_args_t *)calloc(1, sizeof(bun_start_thread_args_t));
  if (!thread_args) {
    set_last_error("failed to allocate Bun start thread args");
    goto fail;
  }
  thread_args->argc = argc;
  thread_args->args = args;
  thread_args->generation = generation;
  thread_args->stdin_read_fd = stdin_pipe[0];
  thread_args->stdout_write_fd = stdout_pipe[1];
  thread_args->stderr_write_fd = stderr_pipe[1];

  pthread_mutex_lock(&g_state_mutex);
  g_bun_live_generation = generation;
  pthread_mutex_unlock(&g_state_mutex);
  if (pthread_create(&bun_thread, NULL, bun_start_thread, thread_args) != 0) {
    pthread_mutex_lock(&g_state_mutex);
    g_bun_live_generation = 0;
    pthread_mutex_unlock(&g_state_mutex);
    set_last_error("failed to start Bun engine thread");
    free(thread_args);
    goto fail;
  }
  args = NULL;
  pthread_detach(bun_thread);
  pthread_mutex_unlock(&g_lifecycle_mutex);
  debug_log("waiting for ios-bridge ready");

  startup_timeout_ms = env_timeout_ms(
      "ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS",
      180000,
      ELIZA_MAX_STARTUP_TIMEOUT_MS);
  ready = wait_for_ready(generation, startup_timeout_ms);
  pthread_mutex_lock(&g_state_mutex);
  if (ready == 0 && generation == g_run_generation && !g_stopping && !g_bun_exited &&
      !g_stream_failed) {
    g_running = 1;
  } else if (ready == 0) {
    ready = -1;
  }
  if (ready == 0) g_starting = 0;
  pthread_cond_broadcast(&g_state_cond);
  pthread_mutex_unlock(&g_state_mutex);
  if (ready != 0) {
    debug_log("ios-bridge ready wait failed code=%d error=%s", ready, eliza_bun_engine_last_error());
    // g_starting stays set until this run is released, so another start
    // cannot begin a run that this cleanup would then tear down.
    pthread_mutex_lock(&g_lifecycle_mutex);
    release_run_resources();
    pthread_mutex_lock(&g_state_mutex);
    g_starting = 0;
    pthread_mutex_unlock(&g_state_mutex);
    pthread_mutex_unlock(&g_lifecycle_mutex);
    return ready;
  }

  debug_log("ios-bridge ready");
  return 0;

fail:
  release_run_resources();
  free_argv(args, argc);
  pthread_mutex_lock(&g_state_mutex);
  g_starting = 0;
  pthread_mutex_unlock(&g_state_mutex);
  pthread_mutex_unlock(&g_lifecycle_mutex);
  return -1;
}

int32_t eliza_bun_engine_stop(void) {
  // Wake a start waiting for readiness and any call waiting for a response
  // before taking the lifecycle lock, which such a start does not hold.
  pthread_mutex_lock(&g_state_mutex);
  g_stopping = 1;
  g_running = 0;
  pthread_cond_broadcast(&g_state_cond);
  pthread_mutex_unlock(&g_state_mutex);
  pthread_mutex_lock(&g_lifecycle_mutex);
  release_run_resources();
  pthread_mutex_unlock(&g_lifecycle_mutex);
  return 0;
}

int32_t eliza_bun_engine_is_running(void) {
  pthread_mutex_lock(&g_state_mutex);
  int running = g_running && !g_bun_exited && !g_reader_done && !g_stream_failed;
  pthread_mutex_unlock(&g_state_mutex);
  return running ? 1 : 0;
}

static void unlink_pending_call_locked(pending_call_t *target) {
  for (pending_call_t **link = &g_pending_calls; *link; link = &(*link)->next) {
    if (*link == target) {
      *link = target->next;
      return;
    }
  }
}

char *eliza_bun_engine_call(const char *method, const char *payload_json) {
  if (!method || method[0] == '\0') {
    return error_json("method is required");
  }
  int timeout_ms = extract_timeout_ms(payload_json);
  pending_call_t *call = (pending_call_t *)calloc(1, sizeof(pending_call_t));
  if (!call) return error_json("out of memory");

  // Calls run concurrently: each registers its id, writes its frame, and waits
  // for the reader thread to hand it the matching response.
  pthread_mutex_lock(&g_state_mutex);
  if (!g_running || g_stopping || g_stdin_write_fd < 0) {
    pthread_mutex_unlock(&g_state_mutex);
    free(call);
    return error_json("ElizaBunEngine is not running");
  }
  uint64_t generation = g_run_generation;
  call->id = g_next_id++;
  call->next = g_pending_calls;
  g_pending_calls = call;
  pthread_mutex_unlock(&g_state_mutex);

  char *escaped_method = json_escape(method);
  const char *payload = payload_json && payload_json[0] ? payload_json : "null";
  size_t req_len = escaped_method ? strlen(escaped_method) + strlen(payload) + 96 : 0;
  char *request = escaped_method ? (char *)malloc(req_len) : NULL;
  if (!request) {
    free(escaped_method);
    pthread_mutex_lock(&g_state_mutex);
    unlink_pending_call_locked(call);
    pthread_mutex_unlock(&g_state_mutex);
    free(call);
    return error_json("out of memory");
  }
  snprintf(
      request,
      req_len,
      "{\"id\":%llu,\"method\":%s,\"payload\":%s}\n",
      (unsigned long long)call->id,
      escaped_method,
      payload);
  free(escaped_method);

  int64_t deadline = monotonic_ms() + timeout_ms;
  int write_result = write_frame(generation, request, strlen(request), deadline);
  int write_errno = errno;
  free(request);

  char *response = NULL;
  int timed_out = write_result == ELIZA_WRITE_TIMEOUT;
  pthread_mutex_lock(&g_state_mutex);
  if (write_result == ELIZA_WRITE_OK) {
    while (!call->done && generation == g_run_generation && !g_stopping &&
           !g_reader_done && !g_stream_failed) {
      if (!wait_state_until(deadline)) {
        timed_out = 1;
        break;
      }
    }
  }
  response = call->response;
  unlink_pending_call_locked(call);
  pthread_mutex_unlock(&g_state_mutex);
  free(call);

  if (response) return response;
  if (timed_out) return timeout_json(timeout_ms);
  if (write_result != ELIZA_WRITE_OK) {
    char message[256];
    snprintf(
        message,
        sizeof(message),
        "failed to write request to Bun bridge: %s",
        strerror(write_errno));
    return error_json(message);
  }
  return error_json("Bun bridge closed before returning a response");
}

void eliza_bun_engine_free(void *ptr) {
  free(ptr);
}
