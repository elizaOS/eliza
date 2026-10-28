# Explicit SQLCipher task provider

Candidate N-API driver for the task store's synchronous `exec`, `prepare().get/run/all`
and `close` interface. `all` returns every row in statement order as plain objects; a row
with a value the driver cannot represent (a blob, or a number beyond the safe-integer range)
fails the whole read, so no partial result is returned. The host supplies an absolute native library path, its
reviewed SHA-256, independent ELF machine and explicit library mode, plus an authorized `resolveKey`
callback returning a disposable 32-byte key. Importing this module opens nothing.
No environment flag enables encryption, no key is placed in SQL or command-line
arguments, and no ordinary SQLite fallback or migration exists.

Build on Linux with Node 24.15.0 headers, C compiler, Perl, Make and tar:

```
node packages/host/native-host/task-sqlcipher/build.mjs /absolute/fresh-output /absolute/node/include/node linux-x64 /usr/bin/cc
ELIZA_TASK_SQLCIPHER_BUILD=/absolute/fresh-output/build.json node --test packages/host/native-host/task-sqlcipher/integration.mjs
ELIZA_TASK_SQLCIPHER_BUILD=/absolute/fresh-output/build.json bun test --timeout 60000 ./packages/host/native-host/task-sqlcipher/integration.mjs
```

`sources.json` pins SQLCipher Community (BSD-3-Clause) and OpenSSL (Apache-2.0)
archives by hash. Build output retains their licenses. OpenSSL and SQLCipher are
statically linked with local symbols; only N-API registration symbols are
exported. Builds use one Make job and refuse reused extracted source directories.
The build manifest records compiler/header/source hashes and the actual ELF.
It does not assert runtime qualification.

For Android Bun, use `x86_64-linux-musl` or `aarch64-linux-musl` and an explicit
compiler executable targeting that triple. Bionic/NDK addons are not compatible
with the embedded musl runtime. A consumer must package the exact library and
licenses with a reviewed artifact manifest, then test it inside the installed
app UID/SELinux domain. Host tests do not establish either Android ABI's readiness.
The current recipe has no automatic APK inventory adoption.

Native open applies the raw key through `sqlite3_key_v2` before schema access,
then verifies exact cipher version, keyed schema read, integrity, memory temp
storage and full synchronization. Caller SQL cannot attach/export a plaintext
copy or change key/temp/durability policy. The provider rechecks the connection
before task-store admission. Its schema is compatible with ordinary task-store
SQL, but plaintext databases and wrong keys are refused without migration.

Qualification requires actual Node and Bun encryption/integrity/wrong-key/plain
SQLite tests, WAL/process-death recovery, temp/canary scanning and both target
ABI proofs. Key custody, authorized account binding, migration, revocation and
non-database evidence/journal encryption remain separate host responsibilities.

`libraryMode: "installed-readonly"` requires a root-owned (UID 0) regular library,
a non-root caller and no group/world write access. The root installer is trusted;
a different unprivileged owner is not. Android installations use
`android-installed` below.
`libraryMode: "android-installed"` is for a library Android extracted from the APK into the
app's native library directory. The package installer owns those files as a system UID
(below the first application UID, 10000); the app, any other app UID and root callers are
refused, as is any group- or world-writable file. That installer is trusted like the root
installer above. The consumer still pins the library's SHA-256 and ELF machine, and must
prove `/proc/self/fd` loading inside its installed app UID and SELinux domain.
`libraryMode: "private-snapshot"` loads a verified copy from an unlinked private
file for host qualification. Both use a pinned file descriptor, retained once per
loaded library for the process lifetime to prevent `dlopen` pathname-cache reuse.
Failure closes the descriptor and removes temporary files. The Android lane must
separately prove `/proc/self/fd` loading under its musl/SELinux configuration.

The database parent must be canonical, owned by the process UID and mode 0700;
existing DBs must be single-link regular files owned by that UID with mode 0600.
New files are created exclusively with mode 0600 before SQLite opens them with
`SQLITE_OPEN_NOFOLLOW`. A malicious same-UID process or privileged installer is
outside this in-process host boundary: neither callbacks nor filesystem paths
establish account authorization. Actual tests inspect DB/WAL/SHM permissions.

The actual database-writing process acquires an exclusive nonblocking `flock`
on a persistent `.writer.lock` before resolving a key or creating a database.
The opaque lease is bound to the exact database path and transferred once to the
N-API connection. Close, failed open, or writer death releases it; never unlink
the lock file. Killing a separate credential broker does not release an orphaned
writer's lock. The descriptor uses `CLOEXEC`, so a spawned executable cannot
retain it. A replaced lock inode fences later operations; the old connection
can still close. This does not change the existing marker-based research lease.

The host can supply a synchronous `checkOwner()` that throws when its native
account/session binding retires. It runs before admission, after key resolution
and native open, and around connection operations. Close remains available
after retirement. Refusal after a write does not imply rollback. The caller must
resolve uncertain outcomes from durable state. The host still owns the native
custody adapter: it must refuse a missing key for any existing DB or sidecar,
including zero-length files, and only create a key for an explicitly new DB.

Run `lease.integration.mjs` with the same explicit build manifest under Node and
Bun to test competing opens, real process death, orphaned writers, exec inheritance,
lock replacement, invalid lock links, and failure cleanup. These are host proofs;
Android musl/SELinux qualification and product adoption remain separate.

Qualification subprocesses default to `process.execPath`. When the installed
runtime needs a loader, set `ELIZA_TASK_TEST_RUNTIME_COMMAND` to an explicit JSON
argument array, such as `["/installed/musl-loader", "/installed/bun"]`. The test
runner appends its worker arguments without a shell. The prefix is inherited by
child and grandchild qualification processes. This affects tests only and does
not alter library admission or the production runtime command.

The explicit Bun qualification command allows 60 seconds for each real-engine
suite, which includes repeated key derivation and process-death recovery. This
does not change the worker-readiness deadlines or any production timeout.

If the OS refuses hardlink fixture creation with `EACCES` or `EPERM`, that one
subtest reports an explicit skip. It does not prove the native multi-link guard.
Run that case on a host that permits hardlinks; the other path-admission checks
remain mandatory on each target. Preserve skips in qualification receipts.
