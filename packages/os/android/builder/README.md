# AOSP builder hosts

Scripts that create and prepare the Linux x86_64 machines that build elizaOS
Android images. Every cloud script prints a dry run by default and acts only with
`--apply`. Nothing here has been run against a real cloud account.

| Role | Where | Why |
| --- | --- | --- |
| Daily builder and Cuttlefish host | Bare metal (e.g. Hetzner AX162-R) | Flat monthly price; native KVM runs every Cuttlefish lane. |
| Release builder | GCE `c3d-highcpu-90` SPOT VM restored from a snapshot of a synced tree | Disposable release builds for about $1–2 each. |
| Cuttlefish host (cloud) | GCE Intel `n2-standard-16` or `c3-highcpu-22` with nested virtualization | x86_64 Cuttlefish lane when no bare-metal host is available. |
| Signing | Separate infrastructure ([release keys](../signing/README.md)) | Builders never hold release keys and produce unsigned target files only. |

- AMD (C3D, C4D) and Arm (C4A) GCE series have no nested virtualization; the c3d
  builder compiles Cuttlefish images but cannot boot them. `cuttlefish-host.sh`
  refuses non-Intel machine types. ARM64 Cuttlefish needs bare-metal ARM64 with `/dev/kvm`.
- VMs have no external IP by default: SSH goes through IAP, egress through the
  Cloud NAT that `builder.sh network` creates.
- VMs get no service account or scopes unless `SERVICE_ACCOUNT` is set (for
  example to upload unsigned artifacts). `EXTRA_LABELS=product=acme` tags resources.

## Sizing against the repository preflight

`assertBuilderCapacity` in
[`scripts/aosp/build-grizzly-bundle.ts`](../../scripts/aosp/build-grizzly-bundle.ts)
(checked for both the source and output filesystems) refuses a host unless it is
Linux x86_64 with at least 32 physical cores (unique `CORE,SOCKET` rows of
`lscpu -p`), 128 GiB RAM, 1500 GB (10^12-based) total disk and 600 GiB free.

| Host | Physical cores | RAM | Build disk | Passes |
| --- | --- | --- | --- | --- |
| GCE `c3d-highcpu-90` | 45 | 180 GB | 1500 GiB Hyperdisk Balanced (≈1610 GB) | Yes, while the tree stays under ~900 GiB |
| GCE `c3-highcpu-88` | 44 | 176 GB | same | Yes |
| GCE `n2-standard-16` | 8 | 64 GB | 300 GB boot | No; Cuttlefish host only |
| Hetzner AX162-R | 48 | 256 GB | 2 × 1.92 TB NVMe | Yes |

`builder.sh` refuses `DATA_DISK_SIZE_GB` below 1500. The cloud-init installs
`/usr/local/sbin/aosp-builder-preflight`, a shell copy of the same thresholds, and
logs to `/var/log/aosp-builder-preflight.log`. Keep both in sync when the
TypeScript preflight changes.

Indicative us-central1 prices (2026-10): `c3d-highcpu-90` ~$0.82/h spot, Hyperdisk
1500 GiB ~$100–150/month while it exists, snapshots ~$0.05/GB-month, Cloud NAT
~$0.045/h plus per-GB processing (a full sync downloads 100+ GB). Check the
pricing calculator before relying on them.

## Files

| File | Purpose |
| --- | --- |
| `gce/builder.sh` | `network`, `create`, `restore`, `start`, `stop`, `snapshot`, `ssh`, `delete` for the SPOT builder and its data disk. |
| `gce/cuttlefish-host.sh` | Same lifecycle for the Intel nested-virtualization Cuttlefish host. |
| `gce/lib.sh` | Shared dry-run helpers; every cloud command goes through `run`. |
| `bootstrap/cloud-init.yaml` | Ubuntu 24.04: AOSP prerequisites, signature-verified `repo`, nofile limits, 64 GiB swap, `builder` user, data disk at `/aosp`, preflight. Holds no secrets. |
| `bootstrap/sync-aosp.sh` | Dry-run-first sync of a profile from [`../aosp.lock.json`](../aosp.lock.json) (default, resolved next to this script) with partial clone, `--reference`, or as a shared `--mirror`. |
| `bootstrap/cuttlefish-host-startup.sh` | GCE startup script that installs `cuttlefish-base` and `cuttlefish-user`. |

Tests: `node --test scripts/__tests__/aosp-builder-infra.node.test.ts` from
`packages/os`. They run `bash -n` and `shellcheck` (when installed) on every
script, including scripts embedded in the cloud-init, and run all dry runs with
fake `gcloud`/`repo` binaries first on `PATH` to prove nothing is invoked.

## Usage

Owner prerequisites (no script does these): a GCP project with billing, the
Compute Engine API and budget alerts; operator roles
`roles/compute.instanceAdmin.v1`, `roles/iap.tunnelResourceAccessor` and
`roles/compute.osAdminLogin`; `gcloud auth login`; your own SSH keys. Never put a
private key, token or password into the cloud-init or these environment variables.

```sh
export PROJECT=my-project ZONE=us-central1-a
packages/os/android/builder/gce/builder.sh network          # dry run; read it
packages/os/android/builder/gce/builder.sh --apply network  # once per project/region
packages/os/android/builder/gce/builder.sh --apply create
packages/os/android/builder/gce/builder.sh --apply ssh
```

On the VM, after `sudo cloud-init status --wait`, copy the lock and the sync
script over, then as `builder`:

```sh
./sync-aosp.sh --lock aosp.lock.json --profile cuttlefish          # dry run
./sync-aosp.sh --lock aosp.lock.json --profile cuttlefish --apply
```

Snapshot the synced tree and restore it per release:

```sh
builder.sh --apply stop
builder.sh --apply snapshot aosp-synced-android-17-0-0-r1
builder.sh --apply delete --data-disk     # stop paying for the disk
builder.sh --apply restore aosp-synced-android-17-0-0-r1
```

SPOT preemption stops the VM and keeps both disks, so `builder.sh --apply start`
resumes an incremental build. Use `PROVISIONING_MODEL=STANDARD` when preemption is
unacceptable. For the cloud Cuttlefish host run `cuttlefish-host.sh --apply create`;
its startup script installs the host packages and reboots once, after which
`/dev/kvm` must exist.

Bare metal: install Ubuntu 24.04, write `AOSP_DATA_DEVICE=/dev/md2` (or the right
device) to `/etc/aosp-builder.env` if the build array is separate (a device is
formatted only when it has no filesystem and no partition table), then seed the
cloud-init through NoCloud:

```sh
cloud-init schema --config-file cloud-init.yaml
sudo install -D -m 0600 cloud-init.yaml /var/lib/cloud/seed/nocloud/user-data
printf 'instance-id: aosp-builder-1\n' | sudo tee /var/lib/cloud/seed/nocloud/meta-data
sudo cloud-init clean --logs && sudo reboot
```

For several workspaces keep one shared mirror (`--mirror --apply`) and point
workspaces at it with `--reference /aosp/mirror`.

### Relationship to `make bootstrap`

`make -C packages/os/android bootstrap` (`scripts/distro-android/bootstrap-aosp.ts`)
remains the canonical checkout for builds: it also materializes external projects
that are not in the AOSP manifest (for example the Pixel 11 Pro adevtool projects).
`sync-aosp.sh` is for preparing builder hosts, mirrors and snapshots with only
bash, git, `repo` and jq or python3. It enforces, before fetching, an HTTPS
`manifest.url`, 40-hex `tagObject`/`commit`, and that `git ls-remote` still shows
the locked tag object and peeled commit; after `repo init`, that
`.repo/manifests` HEAD equals the locked commit; after sync, every locked project
commit (or, in mirror mode, tag and commit in the bare repository) and every
`requiredSourceFiles` path. Projects outside the AOSP manifest therefore fail
closed in `sync-aosp.sh`. Check a finished checkout with
`node packages/os/scripts/aosp/verify-source-lock.ts --profile NAME --aosp-root DIR`.

## Evidence levels

These are separate claims; one never proves another: dry run printed; VM or
server created; bootstrap and preflight passed; `sync-aosp.sh --apply` matched the
lock; AOSP build produced unsigned target files; Cuttlefish image booted on a KVM
host; physical-device boot, signing, OTA and user acceptance.

## Not verified

- No GCE, Hetzner or Cloud NAT resource has been created with these scripts.
  `gcloud` flag names were checked only against `gcloud ... --help`.
- The cloud-init has not been booted. The AppArmor profile that grants user
  namespaces to the prebuilt `nsjail` on Ubuntu 24.04 is untested; if a build fails
  with nsjail or user-namespace errors, the owner chooses between fixing that
  profile and setting `kernel.apparmor_restrict_unprivileged_userns=0` on the host.
- `repo init --mirror` plus the manifest commit check, and `repo sync --no-tags`
  against a tag-pinned manifest, follow documented `repo` behaviour but have not run here.
- The `repo` launcher is verified against the GPG fingerprint published on
  source.android.com (`8BB9AD793E8E6153AF0F9A4416530D5E920F5C65`); the install
  logs its SHA-256. The Cuttlefish apt key fingerprint is logged, not pinned; pin
  it after the first verified install.
