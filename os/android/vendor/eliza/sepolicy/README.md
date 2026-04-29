# ElizaOS sepolicy

Custom selinux policy for the Eliza privileged system app and the
on-device agent it spawns.

`BOARD_VENDOR_SEPOLICY_DIRS += vendor/eliza/sepolicy` (in
`eliza_common.mk`) wires this directory into the board policy. Soong
globs `*.te`, `file_contexts`, and `seapp_contexts` flat at the top
level of the configured dir — so policy lives directly under
`sepolicy/`, not nested in `private/` / `public/` (those subdirs only
apply to platform `system/sepolicy/`).

## Layout

- `file_contexts` — labels for paths the Eliza app or its agent
  runtime creates. Paths under `/data/data/<pkg>/` are NOT labeled by
  installd from this file; the agent service must call `restorecon`
  after copying the bun binary out of `assets/agent/`.
- `eliza_agent.te` — domain + types for the on-device agent
  (`eliza_agent`, `eliza_agent_exec`, `eliza_agent_data`).

## The `eliza_agent` domain

The Eliza priv-app runs in the standard AOSP `priv_app` domain (set by
`seapp_contexts`'s default privileged-app rule, since we don't override
`seinfo`). When that priv-app spawns its on-device agent — `bun` plus a
bundled `@elizaos/agent` — running it in `priv_app` would give it the
priv-app's full policy: SDK Sandbox access, perfetto, virtualization
service, network stats, and so on. Far broader than the agent needs.

`eliza_agent.te` carves the agent into a tighter domain.

### What the agent is allowed to do

- Execute its bundled binary tree (`bun`, `ld-musl-*.so.1`,
  `libstdc++.so`, `libgcc_s.so` — all labeled `eliza_agent_exec`).
- Read/write its own state dir (`eliza_agent_data`).
- Open TCP sockets via the standard `netdomain` attribute. The agent is
  expected to bind to `127.0.0.1:31337` only — SELinux cannot enforce
  the host:port choice (it's a userspace bind() argument, not a label
  decision); that constraint lives in the agent's own code.
- Search/read its parent priv-app data dir (so it can resolve its own
  bundle path on startup).

### What the agent is forbidden from doing

- Acquire any Linux capability (`neverallow eliza_agent self:capability *`).
- Write to anything outside `eliza_agent_data` (`neverallow ... ~{eliza_agent_exec eliza_agent_data privapp_data_file ...}:file …`).
- Create raw / netlink / packet / route sockets — only stream/dgram.
- Transition to any other domain (`priv_app`, `shell`, `su`, etc.).
- Register binder services, set system properties, or touch cgroups.

### How the labels actually reach the files

`file_contexts` in this directory lists patterns like:

```
/data/data/com\.elizaai\.eliza/files/agent/bin(/.*)?  u:object_r:eliza_agent_exec:s0
/data/data/com\.elizaai\.eliza/files/agent(/.*)?      u:object_r:eliza_agent_data:s0
```

But Android's `installd` does NOT consult `file_contexts` for files it
creates inside an app's data dir — it labels them via
`seapp_contexts` (which only knows `privapp_data_file`). For
`eliza_agent_exec` to actually stick to the bun binary on disk, the
`ElizaAgentService` Java code must explicitly invoke
`SELinux.restoreconRecursive("/data/data/ai.elizaos.app/files/agent")`
after copying `assets/agent/` into place. That's the contract Phase B
(the foreground service) has to honour.

### How the domain transition fires

`eliza_agent.te` declares:

```
domain_auto_trans(priv_app, eliza_agent_exec, eliza_agent)
```

When the priv_app `execve()`s a file labeled `eliza_agent_exec`, the
kernel automatically transitions the new process into `eliza_agent`.
No runtime opt-in; if the binary is correctly labeled, the transition
is automatic.

If the binary is NOT correctly labeled (because `restorecon` was
forgotten), the child will run in `priv_app`. Production builds catch
this in `boot-validate.mjs`'s logcat scan — `avc: denied` lines
involving `eliza_agent` would be visible. Lack of `eliza_agent` in
`ps -Z` for the child process is the more obvious symptom.

## Adding rules

1. Reproduce the failure on a userdebug Cuttlefish boot.
2. `adb logcat -d | grep 'avc:'` — copy the denial.
3. Run `audit2allow` against the denial to draft an allow rule.
4. Decide whether the rule belongs in `eliza_agent.te` (anything the
   agent legitimately needs) or whether the denial points at a real
   bug in what the agent is doing. The neverallow set in
   `eliza_agent.te` is the contract — if a denial would require
   crossing one of those, fix the agent, not the policy.
5. Rebuild and verify the denial is gone with `dmesg | grep avc`.

Never commit overly broad `allow` rules — every line of policy is a
security trade. Prefer narrow types (`eliza_agent_data` for state,
`eliza_agent_exec` for binaries) over reusing `system_data_file` or
`privapp_data_file` for agent-owned data.

## Audit-only mode

For initial bring-up, denials log without enforcing if the device is
set permissive (`adb shell setenforce 0`). Production builds run
enforcing — the policy here is the production target, not a relaxed
stub.

If the policy was relaxed during bring-up (e.g. the `dontaudit` lines
in `eliza_agent.te` for proc/sysfs noise), the relaxation should be
followed up with a tighter `allow` once the actual access pattern is
known and the cause is something the agent legitimately needs.
