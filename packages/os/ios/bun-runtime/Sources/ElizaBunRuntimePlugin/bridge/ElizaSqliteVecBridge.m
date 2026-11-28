#import <sqlite3.h>
#import <stddef.h>

__attribute__((weak)) int sqlite3_vec_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
  (void)db;
  (void)pzErrMsg;
  (void)pApi;
  return SQLITE_MISUSE;
}

__attribute__((weak)) const char *sqlite3_vec_version(void) {
  return NULL;
}

int eliza_sqlite_vec_is_available(void) {
  return sqlite3_vec_version() != NULL ? 1 : 0;
}

const char *eliza_sqlite_vec_version(void) {
  return sqlite3_vec_version();
}

int eliza_sqlite_vec_register(sqlite3 *db, char **pzErrMsg) {
  if (eliza_sqlite_vec_is_available() != 1) {
    return SQLITE_MISUSE;
  }
  return sqlite3_vec_init(db, pzErrMsg, NULL);
}
