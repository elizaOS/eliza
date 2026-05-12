# CUDA bring-up — operator steps (this machine, 2026-05-11)

> **Update 2026-05-11 (later):** Steps 1–2 are now DONE — `nvidia-smi` works
> (driver 580.142, `nvidia.ko` loaded), the RTX 5080 Mobile is live, and
> `make -C packages/inference/verify cuda-verify cuda-verify-fused` passes
> 8/8 + 1920/1920 on it. `nvcc` is present but it is the **distro 12.0**
> toolkit, which has no `sm_120`/`compute_120` — it emits `compute_90` PTX
> that the 580 driver JIT-compiles to generic `sm_120` SASS at load. That is
> correct but not the tuned native Blackwell SASS. **The only remaining
> operator step is Step 3 below — `sudo apt install cuda-toolkit-12-8` from
> NVIDIA's repo** — then rebuild `linux-x64-cuda` / `linux-x64-cuda-fused`
> for native `sm_120` SASS (`build-llama-cpp-dflash.mjs` and the verify
> Makefile both auto-detect the `-arch=sm_120` capability and use it when
> the toolkit is ≥12.8; until then they fall back to `compute_90` PTX).
> Steps 1–2 are kept below for the record.

This box has an NVIDIA Blackwell-class mobile dGPU that is **installed but not
runnable**. The agent could not run `sudo`; this is the exact command list for
the operator. Everything below is specific to this hardware/OS:

| Fact | Value |
|---|---|
| GPU | `02:00.0 VGA compatible controller [10de:2c59]` (NVIDIA, rev a1), subsys `1043:3e98` (ASUS) — Blackwell-class mobile, expects CUDA arch `sm_120` / `compute_120` SASS |
| Audio fn | `02:00.1 [10de:22e9]` (bound to `snd_hda_intel`, fine) |
| OS | Ubuntu 24.04.4 LTS, kernel `6.17.0-23-generic` |
| Driver pkg set | `nvidia-driver-580-open` 580.142 (open kernel modules) |
| PRIME mode | `on-demand` (`prime-select query` = `on-demand`) |
| iGPU | Intel Arc/Xe (`i915`/`xe`), used for display — fine to keep |

## Diagnosis (what's actually wrong)

Running `nvidia-smi` → *"couldn't communicate with the NVIDIA driver"*; `nvcc`
not found; `/proc/driver/nvidia/version` absent; `lsmod | grep nvidia` shows
only `nvidia_wmi_ec_backlight` (a laptop backlight shim, **not** the GPU
driver). Root cause:

1. **`dpkg` left the NVIDIA stack half-installed.** `dpkg -l` shows
   `nvidia-dkms-580-open` in state **`iF`** (configuration failed) and most of
   the rest (`nvidia-driver-580-open`, `nvidia-utils-580`,
   `libnvidia-compute-580`, `linux-modules-nvidia-580-open-6.17.0-23-generic`,
   `linux-modules-nvidia-580-open-generic-hwe-24.04`, `nvidia-compute-utils-580`,
   …) in state **`iU`** (unpacked, not configured). The failed `nvidia-dkms`
   postinst blocked the rest of the queue.
2. **Prebuilt modules are present but `depmod` never ran.** The signed prebuilt
   modules exist at
   `/lib/modules/6.17.0-23-generic/kernel/nvidia-580-open/{nvidia,nvidia-uvm,nvidia-modeset,nvidia-drm,nvidia-peermem}.ko`
   (from `linux-modules-nvidia-580-open-6.17.0-23-generic`), but
   `modules.dep` has no `nvidia.ko` entry → `modprobe nvidia` would fail with
   "Module nvidia not found". `depmod -a` is normally run by that package's
   postinst, which never completed (see #1).
3. **DKMS isn't even needed** for kernel 6.17.0-23 — the prebuilt module
   package covers it. (DKMS *is* installed: `/usr/sbin/dkms`,
   `/var/lib/dkms/nvidia/580.142` exists. Kernel headers
   `linux-headers-6.17.0-23-generic` and `gcc-13` are present, so a DKMS build
   would also work if you wanted the source-built path.)
4. **No blacklist is in the way.** `/etc/modprobe.d/` only has the expected
   `nvidia-graphics-drivers-kms.conf` (`modeset=1`, `NVreg_PreserveVideoMemoryAllocations=1`)
   and a `blacklist nvidiafb` (correct — `nvidiafb` is the legacy fbdev driver,
   not the GPU driver).

## Step 1 — finish the half-done install (fixes the dGPU driver)

```bash
sudo dpkg --configure -a            # configures nvidia-dkms + linux-modules-nvidia + driver; runs depmod
sudo apt-get install -f             # belt-and-suspenders; pulls anything still missing
# If nvidia-dkms-580-open still fails to configure, force the DKMS build and inspect:
sudo dkms autoinstall -k 6.17.0-23-generic
sudo cat /var/lib/dkms/nvidia/580.142/build/make.log   # read the actual compile error if it fails
# After a successful configure, refresh module dep map (postinst usually does this):
sudo depmod -a 6.17.0-23-generic
```

## Step 2 — load the driver (no reboot needed if Step 1 succeeded)

```bash
sudo modprobe nvidia
sudo modprobe nvidia_uvm
# Persistence mode (keeps the driver resident; recommended on laptops with PRIME on-demand):
sudo nvidia-smi -pm 1
# Verify:
nvidia-smi                          # should print the GPU table + driver 580.142
nvidia-smi -L                       # "GPU 0: NVIDIA ... (UUID: ...)"
cat /proc/driver/nvidia/version
```

If `modprobe nvidia` still says "Module nvidia not found" after Step 1, the
prebuilt module package didn't install — `sudo apt-get install --reinstall
linux-modules-nvidia-580-open-6.17.0-23-generic nvidia-dkms-580-open` then
`sudo depmod -a` and retry. As a last resort, **reboot** — the initramfs hook +
udev will load the module on boot once the packages are configured.

### Optional: keep the dGPU awake for headless compute

PRIME `on-demand` lets the dGPU drop to D3cold when idle. For compute you
generally don't need to change this — `nvidia-smi`/CUDA wakes it. If you see the
device disappear from `nvidia-smi` between runs, pin runtime power management:

```bash
echo on | sudo tee /sys/bus/pci/devices/0000:02:00.0/power/control
```

(Currently reads `on` already, so usually a no-op here. Do **not** `prime-select
nvidia` — that forces the dGPU to drive the display and is unnecessary for
headless CUDA; it also requires a logout.)

## Step 3 — install a CUDA toolkit that knows `sm_120` (Blackwell)

The driver gives you `libcuda`/`nvidia-smi`; you still need `nvcc` to build the
kernels. **Ubuntu's `apt-get install nvidia-cuda-toolkit` ships CUDA 12.0–12.4,
which does NOT have `sm_120`/`compute_120`** — it will compile but only emit PTX
for the Blackwell GPU (JIT at load, slower, and the `cuda_verify` build may
warn). For real `sm_120` SASS use NVIDIA's CUDA repo with **CUDA 12.8+**:

```bash
# NVIDIA CUDA repo (Ubuntu 24.04 / x86_64):
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt-get update
sudo apt-get install -y cuda-toolkit-12-8     # or a newer 12-x that lists sm_120
# Put it on PATH (add to ~/.bashrc):
export PATH=/usr/local/cuda-12.8/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.8/lib64:$LD_LIBRARY_PATH
nvcc --version                                 # must show 12.8+ and accept -arch=sm_120
```

(Quick-and-dirty fallback if you only need fixture parity, not peak perf:
`sudo apt-get install nvidia-cuda-toolkit` — fine for `make cuda-verify`
correctness checks, just don't trust its throughput numbers on Blackwell.)

`build-llama-cpp-dflash.mjs` already detects which `--gpu-architecture` strings
the installed `nvcc` accepts and appends `sm_100`/`sm_120` only when supported
(see `cudaArchitecturesFlag` / the `linux-x64-cuda` branch), so a 12.8+ toolkit
"just works"; an older one silently drops Blackwell SASS.

## Step 4 — verify the Eliza-1 CUDA path

```bash
cd /home/shaw/eliza/eliza

# Build the CUDA target of the llama.cpp fork (patchCudaKernels + the fused-attn
# flag are wired in; retry once on a fork-cache clobber). No env vars needed —
# the structured-output patch is now tolerant of fork drift:
node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda

# Fixture parity (8/8 — turbo3/turbo4/turbo3_tcq/qjl/polar/polar_qjl + fused):
make -C packages/inference/verify cuda-verify
make -C packages/inference/verify cuda-verify-fused

# Full hardware runner with graph smoke + JSON evidence (needs a smoke GGUF):
ELIZA_DFLASH_SMOKE_MODEL=/path/to/eliza-1-smoke.gguf \
  packages/inference/verify/cuda_runner.sh \
    --report packages/inference/verify/hardware-results/cuda-linux-thismachine-2026-05-11.json

# Sanity (should already pass; run before/after):
make -C packages/inference/verify kernel-contract reference-test
```

A green `cuda_runner.sh` JSON (`status: pass`, `passRecordable: true`,
`graphSmoke: required`, `exitCode: 0`) is the evidence needed to flip
`kernel-contract.json` `runtimeStatus.cuda` / `fusedAttn.runtimeStatus.cuda`
from `needs-hardware` to `runtime-ready` and to drop the
`cuda-linux-thismachine-2026-05-11.pending.json` placeholder.

## If you have no NVIDIA host

Use the cloud runner instead — `packages/training/scripts/cloud/README.md`. It
provisions an H100/A100/RTX-4090 on vast.ai (or Nebius), runs `kernel-verify`,
pulls the JSON back into `verify/hardware-results/`, and tears down. It refuses
to spend without `--yes-i-will-pay` + `VAST_API_KEY`.
