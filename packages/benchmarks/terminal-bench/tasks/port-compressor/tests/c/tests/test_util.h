#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

#define PRETTY_PRINT_TEST_NAME()          \
  {                                       \
    printf("=== %s ===\n", __FUNCTION__); \
  }

#define PRETTY_PRINT_SUB_TEST_NAME() \
  {                                  \
    printf("> %s\n", __FUNCTION__);  \
  }

#define TEST_ASSERT(test, msg)    \
  {                               \
    if (!(test)) {                \
      fprintf(stderr, "ERROR: "); \
      fprintf(stderr, msg);       \
      fprintf(stderr, "\n");      \
      assert(0);                  \
    }                             \
  }

#define TEST_ASSERT_EQ(got, expect, msg)               \
  {                                                    \
    typeof(got) __GOT_STOR = got;                      \
    typeof(expect) __EXPECT_STOR = expect;             \
    if (__GOT_STOR != __EXPECT_STOR) {                 \
      fprintf(stderr, "ERROR: ");                      \
      fprintf(stderr, msg, __EXPECT_STOR, __GOT_STOR); \
      fprintf(stderr, "\n");                           \
      assert(0);                                       \
    }                                                  \
  }
