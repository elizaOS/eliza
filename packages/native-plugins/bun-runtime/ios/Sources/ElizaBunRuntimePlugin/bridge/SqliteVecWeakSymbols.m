#import <sqlite3.h>
#include <stdint.h>
#include <stddef.h>

typedef struct sqlite3_api_routines sqlite3_api_routines;

extern int sqlite3_vec_init(
    sqlite3 *db,
    char **pzErrMsg,
    const sqlite3_api_routines *pApi) __attribute__((weak_import));
extern const char *sqlite3_vec_version(void) __attribute__((weak_import));

int32_t eliza_sqlite_vec_available(void) {
  return sqlite3_vec_init != NULL ? 1 : 0;
}

const char *eliza_sqlite_vec_version(void) {
  if (sqlite3_vec_version == NULL) return NULL;
  return sqlite3_vec_version();
}

int32_t eliza_sqlite_vec_register(sqlite3 *db, char **pzErrMsg) {
  if (sqlite3_vec_init == NULL) return SQLITE_MISUSE;
  return sqlite3_vec_init(db, pzErrMsg, NULL);
}
