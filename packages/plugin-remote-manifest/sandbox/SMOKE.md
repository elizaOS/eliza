# Sub-agent sandbox smoke tests

Manual verification scripts for the OS-level FS sandbox added in SOC2 A-3.

## macOS (`sandbox-exec`)

```bash
# From repo root.
WORKSPACE="$(pwd)"
SESSION="smoke-$(date +%s)"
mkdir -p "${HOME}/.cache/eliza-sub-agent/${SESSION}" "/tmp/eliza-sub-agent-${SESSION}"

# 1. Workspace read should succeed.
/usr/bin/sandbox-exec \
  -D "WORKSPACE=${WORKSPACE}" \
  -D "SESSION=${SESSION}" \
  -D "HOME=${HOME}" \
  -D "TMPDIR=/tmp/" \
  -f packages/plugin-remote-manifest/sandbox/macos.sb \
  /bin/cat "${WORKSPACE}/README.md" >/dev/null && echo "ok: workspace read"

# 2. /etc/passwd read MUST fail (sandbox violation).
/usr/bin/sandbox-exec \
  -D "WORKSPACE=${WORKSPACE}" \
  -D "SESSION=${SESSION}" \
  -D "HOME=${HOME}" \
  -D "TMPDIR=/tmp/" \
  -f packages/plugin-remote-manifest/sandbox/macos.sb \
  /bin/cat /etc/passwd && echo "FAIL: /etc/passwd readable" || echo "ok: /etc/passwd denied"

# 3. ~/.ssh read MUST fail.
/usr/bin/sandbox-exec \
  -D "WORKSPACE=${WORKSPACE}" \
  -D "SESSION=${SESSION}" \
  -D "HOME=${HOME}" \
  -D "TMPDIR=/tmp/" \
  -f packages/plugin-remote-manifest/sandbox/macos.sb \
  /bin/ls "${HOME}/.ssh" && echo "FAIL: ~/.ssh readable" || echo "ok: ~/.ssh denied"
```

Expected output:

```
ok: workspace read
ok: /etc/passwd denied
ok: ~/.ssh denied
```

## Linux (`bwrap`)

```bash
WORKSPACE="$(pwd)"
SESSION="smoke-$(date +%s)"
packages/plugin-remote-manifest/sandbox/linux-bwrap.sh \
  "${WORKSPACE}" "${SESSION}" -- /bin/cat /etc/passwd \
  && echo "FAIL: /etc/passwd readable" || echo "ok: /etc/passwd denied"
```

Notes:

- Both helpers exit non-zero when they cannot establish the jail. Callers
  (`buildSandboxedCommand` in `sandbox.ts`) detect missing helpers ahead
  of time and fall back to env-allowlist-only with a WARN, so dev boxes
  without `bwrap` still work — but production deploys should treat the
  WARN as a P1 fix.
- Windows has no built-in equivalent. The remaining platform boundary in
  `sandbox.ts` documents where AppContainer / Job Object integration belongs.
