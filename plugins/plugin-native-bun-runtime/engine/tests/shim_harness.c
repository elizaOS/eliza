/* Host-side harness for eliza_bun_engine_shim.c. It compiles the shim with a
 * fake bun_start that runs a small ios-bridge stand-in over the real pipes, so
 * the reader thread, request ids, host calls and run restarts are exercised
 * without Bun or an iOS device.
 *
 *   cc -std=c11 -D_GNU_SOURCE -pthread -I engine/tests \
 *     engine/tests/shim_harness.c -o shim_harness && ./shim_harness [scratch-dir]
 *
 * eliza-bun-engine-shim.test.ts in packages/scripts runs it under node:test.
 */
#include "../Sources/ElizaBunEngineShim/eliza_bun_engine_shim.c"

static int g_out = -1;
static int g_failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      g_failures++;                                                     \
      dprintf(g_out, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
    }                                                                   \
  } while (0)

/* ---- fake ios-bridge -------------------------------------------------- */

static void (*g_fake_exit)(uint32_t) = NULL;
static int g_fake_in = -1;
static int g_fake_out = -1;
static char g_fake_argv[4096];
static pthread_mutex_t g_fake_mutex = PTHREAD_MUTEX_INITIALIZER;
static int g_fake_host_results = 0;
static int g_host_calls = 0;

static void fake_write(const char *text) {
  pthread_mutex_lock(&g_fake_mutex);
  (void)!write(g_fake_out, text, strlen(text));
  pthread_mutex_unlock(&g_fake_mutex);
}

static char *fake_read_line(int fd) {
  size_t cap = 256;
  size_t len = 0;
  char *line = (char *)malloc(cap);
  for (;;) {
    char ch;
    ssize_t n = read(fd, &ch, 1);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      free(line);
      return NULL;
    }
    if (ch == '\n') break;
    if (len + 2 > cap) {
      cap *= 2;
      line = (char *)realloc(line, cap);
    }
    line[len++] = ch;
  }
  line[len] = '\0';
  return line;
}

typedef struct {
  int64_t id;
  int delay_ms;
} fake_reply_t;

static void *fake_delayed_reply(void *raw) {
  fake_reply_t *reply = (fake_reply_t *)raw;
  usleep((useconds_t)reply->delay_ms * 1000);
  char frame[128];
  snprintf(frame, sizeof(frame), "{\"id\":%lld,\"ok\":true,\"result\":\"slow\"}\n", (long long)reply->id);
  fake_write(frame);
  free(reply);
  return NULL;
}

static void *fake_bridge(void *unused) {
  (void)unused;
  int in = g_fake_in;
  // A host call before readiness.
  fake_write("{\"type\":\"host_call\",\"id\":\"host-1\",\"method\":\"probe\",\"payload\":{\"n\":1}}\n");
  char *line = fake_read_line(in);
  if (line && strstr(line, "\"host_result\"") && strstr(line, "\"host-1\"")) {
    __atomic_add_fetch(&g_fake_host_results, 1, __ATOMIC_SEQ_CST);
  }
  free(line);
  // The ready frame arrives in two pieces, further apart than one poll slice.
  fake_write("{\"type\":\"ready\",\"ok\":tr");
  usleep(400 * 1000);
  fake_write("ue}\n");
  // A host call while no native call is in flight.
  fake_write("{\"type\":\"host_call\",\"id\":\"host-2\",\"method\":\"probe\",\"payload\":null}\n");
  for (;;) {
    line = fake_read_line(in);
    if (!line) break;
    if (strstr(line, "\"host_result\"")) {
      if (strstr(line, "\"host-2\"")) __atomic_add_fetch(&g_fake_host_results, 1, __ATOMIC_SEQ_CST);
      free(line);
      continue;
    }
    int64_t id = extract_line_id(line);
    char *method = extract_json_string_field(line, "method");
    free(line);
    if (method && strcmp(method, "slow") == 0) {
      fake_reply_t *reply = (fake_reply_t *)malloc(sizeof(fake_reply_t));
      reply->id = id;
      reply->delay_ms = 600;
      pthread_t thread;
      pthread_create(&thread, NULL, fake_delayed_reply, reply);
      pthread_detach(thread);
    } else if (method && strcmp(method, "echo") == 0) {
      char frame[128];
      snprintf(frame, sizeof(frame), "{\"id\":%lld,\"ok\":true,\"result\":\"echo\"}\n", (long long)id);
      fake_write(frame);
    } else if (method && strcmp(method, "die") == 0) {
      free(method);
      g_fake_exit(3);
      return NULL;
    }
    free(method);
  }
  g_fake_exit(0);
  return NULL;
}

int bun_start(
    int argc,
    const char **argv,
    int stdin_fd,
    int stdout_fd,
    int stderr_fd,
    void (*exit_callback)(uint32_t code)) {
  (void)stderr_fd;
  g_fake_argv[0] = '\0';
  for (int i = 0; i < argc; i++) {
    strncat(g_fake_argv, argv[i], sizeof(g_fake_argv) - strlen(g_fake_argv) - 2);
    strcat(g_fake_argv, "\n");
  }
  g_fake_in = stdin_fd;
  g_fake_out = stdout_fd;
  g_fake_exit = exit_callback;
  __atomic_store_n(&g_fake_host_results, 0, __ATOMIC_SEQ_CST);
  pthread_t thread;
  if (pthread_create(&thread, NULL, fake_bridge, NULL) != 0) return 1;
  pthread_detach(thread);
  return 0;
}

static char *test_host_callback(const char *method, const char *payload, int32_t timeout_ms) {
  (void)method;
  (void)payload;
  (void)timeout_ms;
  __atomic_add_fetch(&g_host_calls, 1, __ATOMIC_SEQ_CST);
  return xstrdup("{\"ok\":true,\"result\":{\"pong\":true}}");
}

/* ---- unit checks ------------------------------------------------------ */

static char *parse(const char *json) {
  const char *cursor = json;
  return parse_json_string(&cursor);
}

static void test_parse_json_string(void) {
  char *value = parse("\"caf\\u00e9\"");
  CHECK(value && strcmp(value, "caf\xc3\xa9") == 0);
  free(value);
  value = parse("\"\\ud83d\\ude00!\"");
  CHECK(value && strcmp(value, "\xf0\x9f\x98\x80!") == 0);
  free(value);
  value = parse("\"lone \\ud83d end\"");
  CHECK(value && strcmp(value, "lone \xef\xbf\xbd end") == 0);
  free(value);
  value = parse("\"a\\\"b\\\\c\\n\"");
  CHECK(value && strcmp(value, "a\"b\\c\n") == 0);
  free(value);
  CHECK(parse("\"unterminated") == NULL);
  CHECK(parse("\"ends in backslash\\") == NULL);
  CHECK(parse("\"short \\u00\"") == NULL);
  CHECK(parse("\"bad \\x escape\"") == NULL);

  const char *cursor = "\"first\", \"second\"";
  char *first = parse_json_string(&cursor);
  CHECK(first && strcmp(first, "first") == 0);
  CHECK(strcmp(cursor, ", \"second\"") == 0);
  free(first);
}

static void test_line_buffer(void) {
  line_buffer_t buf = {0};
  int overflow = 0;
  CHECK(line_buffer_append(&buf, "{\"id\":1", 7) == 0);
  CHECK(line_buffer_take_line(&buf, &overflow) == NULL && !overflow);
  CHECK(line_buffer_append(&buf, "}\n{\"id\"", 7) == 0);
  char *line = line_buffer_take_line(&buf, &overflow);
  CHECK(line && strcmp(line, "{\"id\":1}") == 0);
  free(line);
  CHECK(line_buffer_take_line(&buf, &overflow) == NULL && !overflow);
  CHECK(line_buffer_append(&buf, ":2}\r\n\n", 6) == 0);
  line = line_buffer_take_line(&buf, &overflow);
  CHECK(line && strcmp(line, "{\"id\":2}") == 0);
  free(line);
  line = line_buffer_take_line(&buf, &overflow);
  CHECK(line && line[0] == '\0');
  free(line);
  CHECK(buf.len == 0);
  line_buffer_free(&buf);
}

static void test_find_script_arg_index(void) {
  char *with_options[] = {"bun", "--preload", "pre.js", "--env-file", "x.json", "agent.mjs", "ios-bridge"};
  CHECK(find_script_arg_index(with_options, 7) == 5);
  char *json_only[] = {"bun", "config.json", "ios-bridge"};
  CHECK(find_script_arg_index(json_only, 3) == -1);
  char *subcommand_only[] = {"bun", "ios-bridge", "--stdio"};
  CHECK(find_script_arg_index(subcommand_only, 3) == -1);
}

static void test_filter_env_json(void) {
  char *filtered = filter_env_json(
      "{\"A\":\"1\",\"NODE_OPTIONS\":\"--inspect\",\"BUN_JSC_useJIT\":\"1\","
      "\"DYLD_INSERT_LIBRARIES\":\"x\",\"N\":5,\"Q\":\"say \\\"hi\\\"\"}");
  CHECK(filtered && strcmp(filtered, "{\"A\":\"1\",\"Q\":\"say \\\"hi\\\"\"}") == 0);
  free(filtered);
}

/* ---- engine run ------------------------------------------------------- */

static char *g_slow_result = NULL;

static void *slow_call_thread(void *unused) {
  (void)unused;
  g_slow_result = eliza_bun_engine_call("slow", "{\"timeoutMs\":5000}");
  return NULL;
}

static int wait_for_host_results(int expected) {
  for (int i = 0; i < 200; i++) {
    if (__atomic_load_n(&g_fake_host_results, __ATOMIC_SEQ_CST) >= expected) return 1;
    usleep(10 * 1000);
  }
  return 0;
}

static void test_engine_run(const char *dir) {
  setenv("ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS", "5000", 1);
  eliza_bun_engine_set_host_callback(test_host_callback);
  const char *argv_json = "[\"bun\",\"--no-install\",\"public/agent/agent-bundle.js\",\"ios-bridge\",\"--stdio\"]";
  const char *env_json = "{\"A\":\"1\",\"NODE_OPTIONS\":\"--inspect\"}";

  CHECK(eliza_bun_engine_start("/app/public/agent/agent-bundle.js", argv_json, env_json, dir) == 0);
  CHECK(eliza_bun_engine_is_running() == 1);
  CHECK(strstr(g_fake_argv, "bun\n--no-install\n/app/public/agent/agent-bundle.js\nios-bridge\n") == g_fake_argv);
  CHECK(strstr(g_fake_argv, "--eliza-ios-env-json\n{\"A\":\"1\"}\n") != NULL);
  CHECK(strstr(g_fake_argv, "NODE_OPTIONS") == NULL);

  // Both host calls, including the one sent after ready with no native call
  // in flight, are answered.
  CHECK(wait_for_host_results(2));
  CHECK(__atomic_load_n(&g_host_calls, __ATOMIC_SEQ_CST) == 2);

  // A slow call does not hold up a second call.
  pthread_t slow;
  pthread_create(&slow, NULL, slow_call_thread, NULL);
  usleep(100 * 1000);
  int64_t started = monotonic_ms();
  char *echo = eliza_bun_engine_call("echo", "{}");
  int64_t elapsed = monotonic_ms() - started;
  CHECK(echo && strstr(echo, "\"result\":\"echo\""));
  CHECK(elapsed < 400);
  free(echo);
  pthread_join(slow, NULL);
  CHECK(g_slow_result && strstr(g_slow_result, "\"result\":\"slow\""));
  free(g_slow_result);
  g_slow_result = NULL;

  // Stop, then a second run starts once the first bridge has exited.
  eliza_bun_engine_stop();
  CHECK(eliza_bun_engine_is_running() == 0);
  char *stopped = eliza_bun_engine_call("echo", "{}");
  CHECK(stopped && strstr(stopped, "not running"));
  free(stopped);
  CHECK(eliza_bun_engine_start("/app/public/agent/agent-bundle.js", argv_json, env_json, dir) == 0);
  CHECK(eliza_bun_engine_is_running() == 1);
  CHECK(wait_for_host_results(2));
  echo = eliza_bun_engine_call("echo", "{}");
  CHECK(echo && strstr(echo, "\"result\":\"echo\""));
  free(echo);

  // When the bridge dies mid-call the call fails and the engine reports it.
  char *died = eliza_bun_engine_call("die", "{\"timeoutMs\":3000}");
  CHECK(died && strstr(died, "\"ok\":false"));
  CHECK(died && !strstr(died, "timed out"));
  free(died);
  CHECK(eliza_bun_engine_is_running() == 0);
  eliza_bun_engine_stop();
}

int main(int argc, char **argv) {
  g_out = dup(STDOUT_FILENO);
  char fallback_dir[] = "/tmp/eliza-shim-harness-XXXXXX";
  const char *dir = argc > 1 ? argv[1] : mkdtemp(fallback_dir);
  if (!dir) {
    dprintf(g_out, "could not create a scratch directory\n");
    return 1;
  }
  test_parse_json_string();
  test_line_buffer();
  test_find_script_arg_index();
  test_filter_env_json();
  test_engine_run(dir);
  if (g_failures) {
    dprintf(g_out, "%d check(s) failed\n", g_failures);
    return 1;
  }
  dprintf(g_out, "shim harness ok\n");
  return 0;
}
