/* MIT. N-API bridge; SQLCipher and crypto symbols remain local to this addon.
 */
#include "writer-lease.h"
#include <limits.h>
#include <math.h>
#include <node_api.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  sqlite3 *db;
  task_writer_lease *lease;
} connection;
static const napi_type_tag tag = {0xc62b7af032cb4897ULL, 0xa741a56d56d14282ULL};
static napi_value fail(napi_env e) {
  napi_throw_error(e, "TASK_SQLCIPHER_FAILED",
                   "Encrypted task database operation failed");
  return NULL;
}
#define OK(call)                                                               \
  do {                                                                         \
    if ((call) != napi_ok)                                                     \
      return fail(e);                                                          \
  } while (0)
static void wipe(void *p, size_t n) {
  volatile unsigned char *v = p;
  while (n--)
    *v++ = 0;
}
static void dispose(napi_env e, void *p, void *hint) {
  (void)e;
  (void)hint;
  connection *c = p;
  if (c->db)
    sqlite3_close_v2(c->db);
  task_writer_release(c->lease);
  free(c);
}
static connection *unwrap_connection(napi_env e, napi_value v) {
  bool matches = false;
  void *p = NULL;
  if (napi_check_object_type_tag(e, v, &tag, &matches) != napi_ok || !matches)
    return NULL;
  if (napi_unwrap(e, v, &p) != napi_ok || !p || !((connection *)p)->db)
    return NULL;
  return p;
}
static connection *unwrap(napi_env e, napi_value v) {
  connection *c = unwrap_connection(e, v);
  return c && task_writer_current(c->lease) ? c : NULL;
}
static char *string(napi_env e, napi_value v) {
  napi_valuetype t;
  size_t n = 0;
  if (napi_typeof(e, v, &t) != napi_ok || t != napi_string ||
      napi_get_value_string_utf8(e, v, NULL, 0, &n) != napi_ok || n > INT_MAX)
    return NULL;
  char *s = malloc(n + 1);
  if (!s)
    return NULL;
  size_t got = 0;
  if (napi_get_value_string_utf8(e, v, s, n + 1, &got) != napi_ok || got != n ||
      memchr(s, 0, n)) {
    free(s);
    return NULL;
  }
  return s;
}
typedef struct {
  task_writer_lease *lease;
} lease_handle;
static const napi_type_tag lease_tag = {0xb51ee12032bb4881ULL,
                                        0xb852b65e45b15231ULL};
static void dispose_lease(napi_env e, void *p, void *hint) {
  (void)e;
  (void)hint;
  lease_handle *h = p;
  task_writer_release(h->lease);
  free(h);
}
static lease_handle *unwrap_lease(napi_env e, napi_value value) {
  bool matches = false;
  void *p = NULL;
  if (napi_check_object_type_tag(e, value, &lease_tag, &matches) != napi_ok ||
      !matches || napi_unwrap(e, value, &p) != napi_ok)
    return NULL;
  return p;
}
static napi_value acquire_lease(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value a[1], out;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 1)
    return fail(e);
  char *path = string(e, a[0]);
  if (!path)
    return fail(e);
  task_writer_lease *lease = task_writer_acquire(path);
  free(path);
  if (!lease)
    return fail(e);
  lease_handle *h = calloc(1, sizeof(*h));
  if (!h) {
    task_writer_release(lease);
    return fail(e);
  }
  h->lease = lease;
  if (napi_create_object(e, &out) != napi_ok ||
      napi_wrap(e, out, h, dispose_lease, NULL, NULL) != napi_ok) {
    dispose_lease(e, h, NULL);
    return fail(e);
  }
  if (napi_type_tag_object(e, out, &lease_tag) != napi_ok) {
    void *removed = NULL;
    if (napi_remove_wrap(e, out, &removed) == napi_ok)
      dispose_lease(e, h, NULL);
    return fail(e);
  }
  return out;
}
static napi_value release_lease(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value a[1], out;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  lease_handle *h = n == 1 ? unwrap_lease(e, a[0]) : NULL;
  if (!h)
    return fail(e);
  task_writer_release(h->lease);
  h->lease = NULL;
  OK(napi_get_undefined(e, &out));
  return out;
}
static int equal(const char *a, const char *b) {
  return a && sqlite3_stricmp(a, b) == 0;
}
static int authorize(void *p, int action, const char *a, const char *b,
                     const char *c, const char *d) {
  (void)p;
  (void)c;
  (void)d;
  if (action == SQLITE_ATTACH || action == SQLITE_DETACH)
    return SQLITE_DENY;
  if (action == SQLITE_FUNCTION &&
      (equal(b, "load_extension") || equal(b, "sqlcipher_export")))
    return SQLITE_DENY;
  if (action == SQLITE_PRAGMA) {
    if (equal(a, "key") || equal(a, "rekey") || equal(a, "hexkey") ||
        equal(a, "hexrekey"))
      return SQLITE_DENY;
    if (b)
      return (equal(a, "synchronous") && (equal(b, "FULL") || equal(b, "2"))) ||
                     (equal(a, "journal_mode") && equal(b, "WAL"))
                 ? SQLITE_OK
                 : SQLITE_DENY;
    return equal(a, "synchronous") || equal(a, "journal_mode") ||
                   equal(a, "data_version") || equal(a, "schema_version") ||
                   equal(a, "cipher_version") ||
                   equal(a, "cipher_integrity_check") ||
                   equal(a, "cipher_memory_security") || equal(a, "temp_store")
               ? SQLITE_OK
               : SQLITE_DENY;
  }
  return SQLITE_OK;
}
static int scalar(sqlite3 *db, const char *sql, const char *expect) {
  sqlite3_stmt *s = NULL;
  int ok = 0;
  if (sqlite3_prepare_v2(db, sql, -1, &s, NULL) == SQLITE_OK &&
      sqlite3_step(s) == SQLITE_ROW) {
    const unsigned char *v = sqlite3_column_text(s, 0);
    ok = v && strcmp((const char *)v, expect) == 0;
  }
  sqlite3_finalize(s);
  return ok;
}
static int integrity(sqlite3 *db) {
  sqlite3_stmt *s = NULL;
  int ok = sqlite3_prepare_v2(db, "PRAGMA cipher_integrity_check", -1, &s,
                              NULL) == SQLITE_OK &&
           sqlite3_step(s) == SQLITE_DONE;
  sqlite3_finalize(s);
  return ok;
}
static napi_value open_db(napi_env e, napi_callback_info info) {
  size_t n = 3;
  napi_value a[3];
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 3)
    return fail(e);
  lease_handle *lease = unwrap_lease(e, a[2]);
  if (!lease || !task_writer_current(lease->lease))
    return fail(e);
  char *path = string(e, a[0]);
  if (!path || path[0] != '/' || strchr(path, '?') ||
      strcmp(path, lease->lease->database_path)) {
    free(path);
    return fail(e);
  }
  napi_typedarray_type type;
  size_t length, offset;
  void *bytes;
  napi_value buffer;
  if (napi_get_typedarray_info(e, a[1], &type, &length, &bytes, &buffer,
                               &offset) != napi_ok ||
      type != napi_uint8_array || length != 32) {
    free(path);
    return fail(e);
  }
  char raw[68] = "x'";
  const char *hex = "0123456789abcdef";
  for (size_t i = 0; i < 32; i++) {
    raw[2 + i * 2] = hex[((unsigned char *)bytes)[i] >> 4];
    raw[3 + i * 2] = hex[((unsigned char *)bytes)[i] & 15];
  }
  raw[66] = '\'';
  raw[67] = 0;
  connection *c = calloc(1, sizeof(*c));
  if (!c) {
    wipe(raw, sizeof(raw));
    free(path);
    return fail(e);
  }
  c->lease = lease->lease;
  lease->lease = NULL;
  int rc = sqlite3_open_v2(path, &c->db,
                           SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                               SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW,
                           NULL);
  free(path);
  if (rc == SQLITE_OK)
    rc = sqlite3_key_v2(c->db, "main", raw, 67);
  wipe(raw, sizeof(raw));
  if (rc != SQLITE_OK ||
      !scalar(c->db, "PRAGMA cipher_version", ELIZA_SQLCIPHER_VERSION) ||
      sqlite3_exec(c->db, "SELECT count(*) FROM sqlite_schema", NULL, NULL,
                   NULL) != SQLITE_OK ||
      sqlite3_exec(c->db,
                   "PRAGMA cipher_memory_security=ON; PRAGMA "
                   "temp_store=MEMORY; PRAGMA synchronous=FULL",
                   NULL, NULL, NULL) != SQLITE_OK ||
      !scalar(c->db, "PRAGMA temp_store", "2") ||
      !scalar(c->db, "PRAGMA cipher_memory_security", "1") ||
      !integrity(c->db)) {
    dispose(e, c, NULL);
    return fail(e);
  }
  if (sqlite3_db_config(c->db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL) !=
          SQLITE_OK ||
      sqlite3_db_config(c->db, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, NULL) !=
          SQLITE_OK ||
      sqlite3_set_authorizer(c->db, authorize, NULL) != SQLITE_OK) {
    dispose(e, c, NULL);
    return fail(e);
  }
  napi_value out;
  if (napi_create_object(e, &out) != napi_ok ||
      napi_wrap(e, out, c, dispose, NULL, NULL) != napi_ok) {
    dispose(e, c, NULL);
    return fail(e);
  }
  if (napi_type_tag_object(e, out, &tag) != napi_ok) {
    void *removed = NULL;
    if (napi_remove_wrap(e, out, &removed) == napi_ok)
      dispose(e, c, NULL);
    return fail(e);
  }
  return out;
}
static napi_value close_db(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value a[1], v;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 1)
    return fail(e);
  connection *c = unwrap_connection(e, a[0]);
  if (!c)
    return fail(e);
  if (sqlite3_close(c->db) != SQLITE_OK)
    return fail(e);
  c->db = NULL;
  task_writer_release(c->lease);
  c->lease = NULL;
  OK(napi_get_undefined(e, &v));
  return v;
}
static napi_value exec_db(napi_env e, napi_callback_info info) {
  size_t n = 2;
  napi_value a[2], v;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 2)
    return fail(e);
  connection *c = unwrap(e, a[0]);
  char *sql = string(e, a[1]);
  if (!c || !sql) {
    free(sql);
    return fail(e);
  }
  int rc = sqlite3_exec(c->db, sql, NULL, NULL, NULL);
  free(sql);
  if (rc != SQLITE_OK)
    return fail(e);
  OK(napi_get_undefined(e, &v));
  return v;
}
/* Prepares exactly one statement and binds its text, finite safe-integer
 * numbers and nulls. Returns NULL (statement finalized) on any failure. */
static sqlite3_stmt *prepare_bound(napi_env e, connection *c, napi_value sql_value,
                                   napi_value params) {
  char *sql = string(e, sql_value);
  bool array = false;
  if (!sql || napi_is_array(e, params, &array) != napi_ok || !array) {
    free(sql);
    return NULL;
  }
  sqlite3_stmt *s = NULL;
  const char *tail = NULL;
  int rc = sqlite3_prepare_v2(c->db, sql, -1, &s, &tail);
  while (tail &&
         (*tail == ' ' || *tail == '\t' || *tail == '\r' || *tail == '\n'))
    tail++;
  if (rc != SQLITE_OK || !s || (tail && *tail)) {
    sqlite3_finalize(s);
    free(sql);
    return NULL;
  }
  free(sql);
  uint32_t count;
  if (napi_get_array_length(e, params, &count) != napi_ok ||
      count != (uint32_t)sqlite3_bind_parameter_count(s))
    goto error;
  for (uint32_t i = 0; i < count; i++) {
    napi_value arg;
    napi_valuetype t;
    if (napi_get_element(e, params, i, &arg) != napi_ok ||
        napi_typeof(e, arg, &t) != napi_ok)
      goto error;
    if (t == napi_string) {
      char *value = string(e, arg);
      if (!value)
        goto error;
      rc = sqlite3_bind_text(s, i + 1, value, -1, SQLITE_TRANSIENT);
      free(value);
    } else if (t == napi_number) {
      double value;
      if (napi_get_value_double(e, arg, &value) != napi_ok ||
          !isfinite(value) || fabs(value) > 9007199254740991.0)
        goto error;
      rc = sqlite3_bind_double(s, i + 1, value);
    } else if (t == napi_null)
      rc = sqlite3_bind_null(s, i + 1);
    else
      goto error;
    if (rc != SQLITE_OK)
      goto error;
  }
  return s;
error:
  sqlite3_finalize(s);
  return NULL;
}
/* One result row as a plain object: text, finite safe numbers and null only. */
static bool row_object(napi_env e, sqlite3_stmt *s, napi_value *out) {
  napi_value v;
  if (napi_create_object(e, &v) != napi_ok)
    return false;
  for (int i = 0; i < sqlite3_column_count(s); i++) {
    napi_value cell;
    int type = sqlite3_column_type(s, i);
    napi_status status;
    if (type == SQLITE_NULL)
      status = napi_get_null(e, &cell);
    else if (type == SQLITE_INTEGER || type == SQLITE_FLOAT) {
      double x = sqlite3_column_double(s, i);
      if (!isfinite(x) || fabs(x) > 9007199254740991.0)
        return false;
      status = napi_create_double(e, x, &cell);
    } else if (type == SQLITE_TEXT)
      status = napi_create_string_utf8(e, (const char *)sqlite3_column_text(s, i),
                                       sqlite3_column_bytes(s, i), &cell);
    else
      return false;
    if (status != napi_ok)
      return false;
    napi_property_descriptor prop = {
        sqlite3_column_name(s, i), NULL, NULL, NULL, NULL, cell,
        napi_enumerable | napi_writable | napi_configurable, NULL};
    if (napi_define_properties(e, v, 1, &prop) != napi_ok)
      return false;
  }
  *out = v;
  return true;
}
static napi_value query(napi_env e, napi_callback_info info) {
  size_t n = 4;
  napi_value a[4], v;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 4)
    return fail(e);
  connection *c = unwrap(e, a[0]);
  bool get = false;
  if (!c || napi_get_value_bool(e, a[3], &get) != napi_ok)
    return fail(e);
  sqlite3_stmt *s = prepare_bound(e, c, a[1], a[2]);
  if (!s)
    return fail(e);
  int rc = sqlite3_step(s);
  if (get) {
    if (rc == SQLITE_DONE) {
      if (napi_get_undefined(e, &v) != napi_ok)
        goto error;
    } else if (rc != SQLITE_ROW || !row_object(e, s, &v))
      goto error;
  } else {
    while (rc == SQLITE_ROW)
      rc = sqlite3_step(s);
    if (rc != SQLITE_DONE)
      goto error;
    if (napi_get_undefined(e, &v) != napi_ok)
      goto error;
  }
  sqlite3_finalize(s);
  return v;
error:
  sqlite3_finalize(s);
  return fail(e);
}
/* Every result row, in statement order, as an array of plain objects. A row
 * that cannot be represented fails the whole read; nothing partial returns. */
static napi_value query_all(napi_env e, napi_callback_info info) {
  size_t n = 3;
  napi_value a[3], rows;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 3)
    return fail(e);
  connection *c = unwrap(e, a[0]);
  if (!c)
    return fail(e);
  sqlite3_stmt *s = prepare_bound(e, c, a[1], a[2]);
  if (!s)
    return fail(e);
  if (napi_create_array(e, &rows) != napi_ok)
    goto error;
  uint32_t index = 0;
  int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    napi_value row;
    if (index == UINT32_MAX || !row_object(e, s, &row) ||
        napi_set_element(e, rows, index++, row) != napi_ok)
      goto error;
  }
  if (rc != SQLITE_DONE)
    goto error;
  sqlite3_finalize(s);
  return rows;
error:
  sqlite3_finalize(s);
  return fail(e);
}
static napi_value verify(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value a[1], v;
  OK(napi_get_cb_info(e, info, &n, a, NULL, NULL));
  if (n != 1)
    return fail(e);
  connection *c = unwrap(e, a[0]);
  if (!c || !scalar(c->db, "PRAGMA cipher_version", ELIZA_SQLCIPHER_VERSION) ||
      !scalar(c->db, "PRAGMA temp_store", "2") ||
      !scalar(c->db, "PRAGMA synchronous", "2") ||
      !scalar(c->db, "PRAGMA cipher_memory_security", "1") || !integrity(c->db))
    return fail(e);
  OK(napi_get_boolean(e, true, &v));
  return v;
}
static napi_value init(napi_env e, napi_value exports) {
  napi_property_descriptor props[] = {
      {"acquireLease", 0, acquire_lease, 0, 0, 0, napi_default, 0},
      {"releaseLease", 0, release_lease, 0, 0, 0, napi_default, 0},
      {"open", 0, open_db, 0, 0, 0, napi_default, 0},
      {"exec", 0, exec_db, 0, 0, 0, napi_default, 0},
      {"query", 0, query, 0, 0, 0, napi_default, 0},
      {"queryAll", 0, query_all, 0, 0, 0, napi_default, 0},
      {"close", 0, close_db, 0, 0, 0, napi_default, 0},
      {"verify", 0, verify, 0, 0, 0, napi_default, 0}};
  OK(napi_define_properties(e, exports, 8, props));
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
