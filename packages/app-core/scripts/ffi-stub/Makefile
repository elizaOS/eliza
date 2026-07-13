# Builds libelizainference_stub.{dylib,so} from ffi-stub.c.
#
# This produces a real shared library that exports the same symbol set
# as the (planned) fused build, so the JS FFI binding can be tested
# end-to-end without requiring the full omnivoice + llama.cpp fusion.
#
# Usage:
#   make                            # builds the platform-default artifact
#   make libelizainference_stub.dylib   # macOS
#   make libelizainference_stub.so      # Linux
#   make build-output OUTPUT=/tmp/libelizainference_stub.so
#   make verify                     # builds + lists exported eliza_* symbols
#   make clean

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

CC      ?= clang
CFLAGS  := -Wall -Wextra -Wpedantic -Werror -O2 -fPIC -std=c11 -fvisibility=default
LDFLAGS_DARWIN := -shared -Wl,-install_name,@rpath/libelizainference_stub.dylib
LDFLAGS_LINUX  := -shared -Wl,-soname,libelizainference_stub.so

ifeq ($(UNAME_S),Darwin)
DEFAULT_TARGET := libelizainference_stub.dylib
REAL_LIB_NAME  := libelizainference.dylib
VERIFY_TARGET  := darwin-$(if $(filter arm64,$(UNAME_M)),arm64,x64)-metal-fused
NM             := nm -gU
PLATFORM_LDFLAGS := $(LDFLAGS_DARWIN)
else
DEFAULT_TARGET := libelizainference_stub.so
REAL_LIB_NAME  := libelizainference.so
VERIFY_TARGET  := linux-x64-cpu-fused
NM             := nm -D --defined-only
PLATFORM_LDFLAGS := $(LDFLAGS_LINUX)
endif

REPO_ROOT := $(abspath ../../../..)
RM_PATH_RECURSIVE := node $(REPO_ROOT)/packages/scripts/rm-path-recursive.mjs

.PHONY: all build-output clean verify verify-stub-rejected
all: $(DEFAULT_TARGET)

build-output: ffi-stub.c ffi.h
	@test -n "$(OUTPUT)" || (echo "OUTPUT is required" && exit 1)
	@mkdir -p "$(dir $(OUTPUT))"
	$(CC) $(CFLAGS) $(PLATFORM_LDFLAGS) -o "$(OUTPUT)" ffi-stub.c

libelizainference_stub.dylib: ffi-stub.c ffi.h
	$(CC) $(CFLAGS) $(LDFLAGS_DARWIN) -o $@ ffi-stub.c

libelizainference_stub.so: ffi-stub.c ffi.h
	$(CC) $(CFLAGS) $(LDFLAGS_LINUX) -o $@ ffi-stub.c

verify: $(DEFAULT_TARGET)
	@echo "[verify] eliza_* exports in $(DEFAULT_TARGET):"
	@$(NM) $(DEFAULT_TARGET) | grep -E ' _?eliza_inference_' || \
		(echo "[verify] FAILED: no eliza_inference_* symbols found" && exit 1)

verify-stub-rejected: $(DEFAULT_TARGET)
	@tmp=$$(mktemp -d); \
	cp $(DEFAULT_TARGET) $$tmp/$(REAL_LIB_NAME); \
	if node ../build-helpers/verify-fused-symbols.mjs --out-dir $$tmp --target $(VERIFY_TARGET) --json >$$tmp/stdout 2>$$tmp/stderr; then \
		echo "[verify] FAILED: real verifier accepted the stub as $(REAL_LIB_NAME)"; \
		cat $$tmp/stdout; \
		$(RM_PATH_RECURSIVE) $$tmp; \
		exit 1; \
	fi; \
	test -s $$tmp/OMNIVOICE_FUSE_VERIFY.json; \
	grep -q '"ok": false' $$tmp/OMNIVOICE_FUSE_VERIFY.json; \
	grep -q 'stub' $$tmp/OMNIVOICE_FUSE_VERIFY.json; \
	echo "[verify] PASS: real verifier rejects stub-only libelizainference"; \
	$(RM_PATH_RECURSIVE) $$tmp

clean:
	rm -f libelizainference_stub.dylib libelizainference_stub.so
