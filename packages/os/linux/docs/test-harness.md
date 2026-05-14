# VM test harness — contributor reference

> Last update aligned with milestone 11d (2026-05-10).

The harness lives under `vm/`. It boots a reproducible Debian sid qcow2
under headless QEMU and drives Eliza through the same path a real user
would: type a message into the chat box, wait for the result, assert.

This document is intended for contributors who need to extend the
harness or debug a failing smoke. The strategic context is in
[`PLAN.md`](../PLAN.md) and the safety guarantees are in
[`docs/safety.md`](./safety.md).

## Layout

```
vm/
├── disk-base/
│   ├── mmdebstrap.recipe        # apt list + Ollama install URL + bundled GGUF list
│   └── overlay/                 # files copied INTO the qcow2 (sway config,
│                                # systemd units, the input listener script)
├── scripts/
│   ├── build-base.sh            # produces vm/disk-base.qcow2 (idempotent)
│   ├── boot.sh                  # qemu-system-x86_64 invocation
│   ├── deploy.sh                # scp host artifacts into a running VM
│   ├── inject.py                # talk to QMP + the in-VM listener
│   ├── run-tests.sh             # full smoke: boot → deploy → 5 scenarios
│   └── teardown.sh              # graceful QMP shutdown + socket cleanup
├── .ssh/                        # per-host harness SSH key (private gitignored)
└── snapshots/                   # gitignored: qcow2 snapshots, screenshots,
                                 # qmp.sock / serial.sock / input.sock
```

## Lifecycle

1. **`just vm-build-base`** — runs `vm/scripts/build-base.sh`:
   1. Downloads (or reuses) the Debian sid generic-cloud qcow2 from
      `cloud.debian.org/images/cloud/sid/daily/latest/` into
      `vm/disk-base/.cache/upstream.qcow2`.
   2. `cp` to `vm/disk-base.qcow2`, `qemu-img resize` to 16 GB.
   3. `virt-customize` pass 1: apt update + install the v1 package list
      from `mmdebstrap.recipe` (sway, bubblewrap, chromium, wtype, grim,
      python3, network-manager, openssh-server, …); copy the `overlay/`
      tree into `/etc` and `/usr/local/bin`; add the `eliza` user and
      install the harness SSH public key into `authorized_keys`.
   4. `virt-customize` pass 2: install Ollama via the upstream
      `https://ollama.com/install.sh` script (skipped if already
      present); enable the systemd unit.
   5. `virt-customize` pass 3 (per model): start `ollama serve` inside
      the appliance, `ollama pull <model>`, stop. Pre-populates the
      model store under `/usr/share/ollama/.ollama` so the live image
      doesn't need to fetch anything on first boot.
   6. `virt-customize` pass 4: install Bun via the upstream
      `https://bun.com/install` script as the `eliza` user, symlink
      `/usr/local/bin/bun → /home/eliza/.bun/bin/bun`.

2. **`just vm-up`** — runs `vm/scripts/boot.sh --headless --snapshot`:
   `qemu-system-x86_64 -enable-kvm -snapshot -display none -vga virtio
   -netdev user,hostfwd=tcp::2222-:22 -device virtio-net-pci -qmp
   unix:vm/snapshots/qmp.sock,server,nowait -chardev socket,…
   -serial chardev:serial0 -chardev socket,id=input0,path=…
   -device virtio-serial-pci -device virtserialport,chardev=input0,name=usbeliza.input`.

3. **`just vm-deploy`** — `vm/scripts/deploy.sh`:
   1. Polls real `ssh ... 'true'` round-trip until success (TCP-open is
      not enough; sshd's kex handshake races boot).
   2. `cargo build -p elizad --release` on the host.
   3. `bun install --frozen-lockfile` in `agent/` on the host.
   4. `scp target/release/elizad → /opt/usbeliza/bin/elizad`,
      symlink `/usr/local/bin/elizad → /opt/usbeliza/bin/elizad`.
   5. `rsync agent/ → /opt/usbeliza/agent/` (source + node_modules).
   6. `sudo systemctl restart elizad-session.service` so sway re-execs
      elizad with the new binary.

4. **`just vm-test`** — `vm/scripts/run-tests.sh`:
   - Boots the VM, polls for SSH, runs `vm-deploy`.
   - Pings the in-VM input listener.
   - Iterates the 5 canonical scenarios (calendar, notes, text-editor,
     clock, calculator). For each:
     - `inject.py type "build me a <slug>"` → Wayland keystroke injection
       inside the guest via `wtype`.
     - `inject.py submit` → Enter.
     - `inject.py wait-for <slug> 300000` → in-VM listener polls
       `~/.eliza/apps/<slug>/manifest.json`.
     - SSH-side `test -f` independently confirms the manifest + entry.
     - `inject.py guest-screenshot <slug>-after-build` → `grim` on the
       Wayland output.
   - After all 5: pulls `/var/tmp/usbeliza-screenshots` back to host,
     captures a QMP framebuffer screenshot, asserts size > 1 KB.
   - Returns non-zero on any step failure.

5. **`just vm-down`** — graceful shutdown via QMP `system_powerdown` +
   socket cleanup.

## Assertion philosophy

LLM-generated artifacts are not byte-stable. The harness asserts
**behavior**, not exact strings:

| What we assert | Why |
|---|---|
| Manifest + entry file exist on disk | Codegen completed and validated |
| Screenshot is > 1 KB | The display surface isn't all-black — sway + chromium are running |
| `time:read` returns RFC 3339 + IANA TZ | Cap-bus dispatch reaches the handler |
| `storage:scoped` write→read round-trips | Per-app data dir is wired |
| Two apps' values don't leak | Per-app cap socket isolation works |

What the harness does **not** assert (LLM-output drift):

- Specific HTML markup
- Specific calendar styling
- Specific reply text from the chat handler

Token-level snapshot tests are forbidden in this codebase.

## Adding a scenario

The 5-canonical loop in `run-tests.sh` reads from a `SCENARIOS` array.
Add a sixth via `<slug>:<intent phrase>`:

```sh
declare -a SCENARIOS=(
    "calendar:build me a calendar"
    "notes:build me a notes app"
    "text-editor:build me a simple text editor"
    "clock:build me a clock"
    "calculator:build me a calculator"
    "weather:show me the weather"   # new
)
```

The slug must match the regex enforced by `eliza_sandbox::validate`:
`^[a-z0-9][a-z0-9-]*$`. The intent phrase must match
`agent/src/intent.ts`'s `BUILD_RE` or `OPEN_RE` so the codegen path
fires (rather than the chat fallthrough).

## Debugging a failed smoke

The most useful artifacts after a failed smoke:

| Where | What |
|---|---|
| `vm/snapshots/qmp-after-build.png` | Last QMP screenshot — shows the Wayland framebuffer |
| `vm/snapshots/guest-screenshots/` | grim screenshots taken inside the guest (post-build) |
| `vm/snapshots/serial.sock` | Serial console — connect with `socat - UNIX-CONNECT:vm/snapshots/serial.sock` to see kernel + systemd logs |
| `journalctl -u elizad-session` over SSH | Sway + elizad startup log |
| `journalctl -u usbeliza-input-listener` | Listener log; `[input-listener] ping` on every harness ping |
| `journalctl -u ollama` | Local Llama health |
| `~/.eliza/apps/<slug>/` | Anything that DID get generated, even if validation later failed |

Pin a faulty image for inspection: `vm/scripts/boot.sh --gui --persistent`
runs the same VM with a GUI window and disables snapshot mode so writes
land on disk for the next inspection.
