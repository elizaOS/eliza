# TH1520 Physical Board Procurement And Test Plan

This plan selects three TH1520 development boards as physical software baselines
for Eliza-AI-SoC: BeagleV-Ahead, Sipeed Lichee Pi 4A, and Milk-V Meles. The
goal is not to claim phone-class performance. The goal is to get reproducible
Linux and Android-adjacent boot, debug, log, and benchmark evidence on real
quad-core C910 silicon with a TH1520 NPU/GPU/display stack.

## Board Set

| Board | Buy target | Why it is in scope | Procurement gate |
|---|---:|---|---|
| BeagleV-Ahead | 2 units | BeagleBoard documentation, open hardware collateral, TH1520 JTAG/UART exposure, 4 GB LPDDR4 and 16 GB eMMC baseline. | Purchase only if the vendor listing names BeagleV-Ahead and includes antenna or clearly lists it separately. |
| Lichee Pi 4A | 2 units | Highest-memory TH1520 option, Sipeed image/debug docs, RevyOS and Android image paths, optional MIPI/camera accessories. | Prefer 16 GB RAM / 128 GB eMMC official version; record SOM QR code and baseboard QR code. |
| Milk-V Meles | 2 units | TH1520 board with eMMC socket, microSD, SPI NOR, documented 40-pin, JTAG, and UART paths. | Prefer 8 GB or 16 GB RAM with eMMC module; record printed hardware revision such as `Meles V1.2`. |

Buy two of each board: one clean reference unit and one destructive/recovery
unit. Do not mix board revisions in a single result table unless the revision is
part of the result key.

## Required Accessories

Minimum shared lab kit:

- Linux host with `fastboot`, `adb`, `tio`, `picocom`, `minicom`, `screen`,
  `git`, `gcc`, `make`, `fio`, `lmbench`, `stress-ng`, `perf`, `bc`, `jq`,
  `usbutils`, and `pciutils` where available.
- USB power meter capable of logging 5 V input power.
- Powered USB hub with per-port power switches.
- Gigabit Ethernet switch and known-good CAT6 cables.
- HDMI monitor, HDMI capture dongle, and the board-specific HDMI cable:
  mini-HDMI for BeagleV-Ahead, full-size HDMI for Meles, and the connector
  required by the purchased Lichee Pi 4A kit.
- Class A2 or better 64 GB microSD cards, at least two per board.
- USB-to-UART adapters with selectable or verified logic level. Use CP2102N or
  Raspberry Pi Debug Probe for BeagleV-Ahead. Use Sipeed RV Debugger Plus or a
  verified 3.3 V-compatible adapter for current Lichee Pi 4A release boards.
- JTAG/debug tools: Sipeed RV Debugger Plus or SLogic Combo 8 in CKLink mode for
  Lichee Pi 4A, and a RISC-V-capable JTAG adapter plus board-specific cable for
  BeagleV-Ahead and Meles.
- ESD mat, ESD wrist strap, Dupont leads, spare USB-C data cables, USB 3.0
  micro-B data cable for BeagleV-Ahead flashing, and USB-A-to-C data cable for
  Meles eMMC flashing.

Board-specific accessories:

| Board | Must-have | Optional but useful |
|---|---|---|
| BeagleV-Ahead | 5 V / 2 A barrel supply, USB 3.0 micro-B data cable, UART adapter, mini-HDMI cable, Ethernet cable. | microSD cards for SD boot tests, camera/display flex accessories only after boot is stable. |
| Lichee Pi 4A | Active heatsink/fan, USB-C data cable, 12 V / 2 A supply if using external peripherals, UART/JTAG debugger. | 10.1 inch MIPI touch screen, OV5693 camera, PoE module, aluminum case for thermal repeatability. |
| Milk-V Meles | 5 V / 3 A USB-C supply, eMMC module, microSD card, UART adapter, Ethernet cable, HDMI cable. | PoE injector/module, fan, spare eMMC modules for image A/B testing. |

## Image And Flashing Paths

Record every image as `artifacts/th1520/<board>/images/<image-name>/` with:

```sh
sha256sum * | tee SHA256SUMS
date -u +"%Y-%m-%dT%H:%M:%SZ" | tee FETCHED_AT
```

### BeagleV-Ahead

Expected Linux image path:

1. Download the latest BeagleV-Ahead distro from
   `https://www.beagleboard.org/distros`.
2. Put the board into USB flash mode by holding the USB button while connecting
   the USB micro-B cable, or by holding USB and pressing reset when already
   connected.
3. Unzip the image bundle and confirm it contains `u-boot-with-spl.bin`,
   `boot.ext4`, `root.ext4`, and `fastboot_emmc.sh`.
4. Flash with:

```sh
sudo ./fastboot_emmc.sh 2>&1 | tee artifacts/th1520/beaglev-ahead/logs/flash-$(date -u +%Y%m%dT%H%M%SZ).log
```

Expected Android status: no product Android bring-up is assumed for
BeagleV-Ahead. Treat the Beagle image as a Yocto/Linux baseline unless a
current official distro explicitly ships Android artifacts.

### Lichee Pi 4A

Expected Linux image path:

1. Start from Sipeed's Lichee Pi 4A image summary, but prefer the current RevyOS
   docs when the Sipeed page redirects Linux users there.
2. Match U-Boot and DTB to board memory size: no suffix for 8 GB, `16g` suffix
   for 16 GB.
3. Enter USB burning mode by holding BOOT while connecting USB-C to the host.
   On release hardware, confirm the DIP switch is in eMMC boot mode.
4. Confirm host detection:

```sh
lsusb | tee artifacts/th1520/lichee-pi-4a/logs/lsusb-burning-mode.log
```

5. Flash the Linux image with the image bundle's fastboot, using the image
   release's required fastboot when large root filesystems are involved:

```sh
sudo ./fastboot flash ram ./images/u-boot-with-spl-lpi4a-16g.bin
sudo ./fastboot reboot
sleep 1
sudo ./fastboot flash uboot ./images/u-boot-with-spl-lpi4a-16g.bin
sudo ./fastboot flash boot ./images/boot_sing.ext4
sudo ./fastboot flash root ./images/rootfs-sing.ext4
```

Expected Android image path:

1. Use only the Sipeed Android 13 package named by the current image summary.
2. Treat Android as experimental. A booting shell, `adb devices`, `logcat`, and
   surface/display proof are useful; CTS/VTS success is not expected for v0.
3. Flash the complete Android partition set:

```sh
fastboot flash ram u-boot-with-spl.bin
fastboot reboot
fastboot flash uboot u-boot-with-spl.bin
fastboot flash bootpart bootpart.ext4
fastboot flash boot boot.img
fastboot flash vendor_boot vendor_boot.img
fastboot flash super super.img
fastboot flash userdata userdata.img
fastboot flash vbmeta vbmeta.img
fastboot flash vbmeta_system vbmeta_system.img
fastboot erase metadata
fastboot erase misc
```

### Milk-V Meles

Expected Linux image path:

1. Use Milk-V Meles official image resources for RevyOS first.
2. Select target media per test: SPI NOR firmware, microSD card image, or eMMC
   image.
3. For microSD, flash from the host:

```sh
xzcat <meles-image>.img.xz | sudo dd of=/dev/sdX bs=4M conv=fsync status=progress
sync
```

4. For eMMC, use Milk-V's eMMC installation flow and a USB-A-to-C data cable
   with fastboot. The board exposes Download and eMMC boot buttons; record the
   exact button sequence used in the log.

Expected Android status: no Android result is assumed unless Milk-V publishes a
board-specific Android image. Use Meles as a Linux/RevyOS comparison board.

## Serial, JTAG, And Log Capture

Serial capture is mandatory before any benchmark is valid.

```sh
mkdir -p artifacts/th1520/<board>/logs
script -f artifacts/th1520/<board>/logs/serial-$(date -u +%Y%m%dT%H%M%SZ).typescript \
  -c "tio /dev/ttyUSB0 -b 115200"
```

Required boot-log markers:

- ROM or SPL output, if exposed.
- U-Boot banner and DRAM size.
- OpenSBI banner.
- Linux kernel command line.
- Root filesystem mount.
- Login prompt, shell, or Android `adb` authorization state.
- `uname -a`, `/proc/cpuinfo`, `/proc/meminfo`, `lsblk`, `ip addr`, and
  `/proc/device-tree/model`.

JTAG policy:

- JTAG is a recovery/debug tool, not the primary flashing path.
- For Lichee Pi 4A, use CKLink mode and the documented pinmux step before
  opening the vendor debug server:

```sh
sudo memtool mw 0xfffff4a404 0
DebugServerConsole
```

- For BeagleV-Ahead and Meles, first prove non-invasive JTAG attach at reset
  halt. Do not write memory or flash over JTAG until UART and vendor flashing
  recovery have been proven.
- Store JTAG transcripts under `artifacts/th1520/<board>/logs/jtag-*`.

Android log capture, when Android boots:

```sh
adb wait-for-device
adb shell getprop | tee artifacts/th1520/<board>/logs/android-getprop.txt
adb logcat -b all -d | tee artifacts/th1520/<board>/logs/android-logcat.txt
adb shell dmesg | tee artifacts/th1520/<board>/logs/android-dmesg.txt
```

Linux log capture:

```sh
uname -a | tee artifacts/th1520/<board>/logs/uname.txt
cat /proc/cpuinfo | tee artifacts/th1520/<board>/logs/cpuinfo.txt
cat /proc/meminfo | tee artifacts/th1520/<board>/logs/meminfo.txt
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS | tee artifacts/th1520/<board>/logs/lsblk.txt
dmesg -T | tee artifacts/th1520/<board>/logs/dmesg.txt
```

## Benchmark Commands

Run benchmarks only after the board has a heatsink/fan installed, a stable power
source, and an idle temperature log. For each benchmark, capture ambient
temperature, cooling setup, power method, board revision, image SHA256, kernel,
governor, and clock policy.

Preparation:

```sh
mkdir -p ~/bench && cd ~/bench
sudo sh -c 'echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor' || true
for z in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  sudo sh -c "echo performance > $z" || true
done
```

CPU smoke:

```sh
git clone https://github.com/eembc/coremark.git
cd coremark
make PORT_DIR=linux XCFLAGS="-O3 -DPERFORMANCE_RUN=1" run1.log
tee ~/bench/coremark-summary.txt < run1.log
```

Memory bandwidth:

```sh
git clone https://github.com/jeffhammond/STREAM.git
cd STREAM
gcc -O3 -fopenmp -DSTREAM_ARRAY_SIZE=80000000 -DNTIMES=20 stream.c -o stream
OMP_NUM_THREADS=$(nproc) ./stream | tee ~/bench/stream.txt
```

Memory latency:

```sh
lat_mem_rd 256M 64 2>&1 | tee ~/bench/lmbench-lat-mem-rd.txt
bw_mem 512M rd 2>&1 | tee ~/bench/lmbench-bw-mem-rd.txt
bw_mem 512M wr 2>&1 | tee ~/bench/lmbench-bw-mem-wr.txt
```

Storage:

```sh
fio --name=seqread --filename=~/bench/fio.test --size=1G --bs=1M --rw=read \
  --direct=1 --iodepth=16 --runtime=60 --time_based --group_reporting \
  | tee ~/bench/fio-seqread.txt
fio --name=randread --filename=~/bench/fio.test --size=1G --bs=4k --rw=randread \
  --direct=1 --iodepth=32 --runtime=60 --time_based --group_reporting \
  | tee ~/bench/fio-randread.txt
```

Network:

```sh
iperf3 -s
# from host:
iperf3 -c <board-ip> -P 4 -t 60 | tee artifacts/th1520/<board>/bench/iperf3-client.txt
```

NPU and Android-adjacent smoke:

```sh
# Linux NPU visibility
lsmod | tee ~/bench/lsmod.txt
find /dev /sys -iname '*npu*' -o -iname '*thead*' | tee ~/bench/npu-nodes.txt

# If TensorFlow Lite benchmark_model is available
benchmark_model --graph=mobilenet_v1_1.0_224_quant.tflite --num_threads=4 \
  --warmup_runs=5 --num_runs=50 | tee ~/bench/tflite-cpu.txt

# If Android boots
adb shell cmd package list packages | tee artifacts/th1520/<board>/bench/android-packages.txt
adb shell am start -W com.android.settings/.Settings | tee artifacts/th1520/<board>/bench/android-settings-start.txt
```

Do not report NPU TOPS from marketing material as a measured project result.
Report model name, delegate/runtime, precision, latency distribution, fallback
rate, CPU utilization, memory bandwidth indicators, and power.

## Pass/Fail Gates

Procurement pass:

- Board model and revision are photographed and recorded.
- Accessories required for power, serial, flashing, display, and Ethernet are in
  hand.
- Official image source URL, image filename, fetch date, and SHA256 are stored.

Boot pass:

- Board reaches U-Boot and Linux or Android userspace from the intended media.
- Serial log includes ROM/SPL or first visible bootloader output through login.
- DRAM size, storage size, Ethernet MAC, and board model match purchased
  configuration or have a written explanation.

Debug pass:

- UART is stable at 115200 baud for a full cold boot.
- Recovery flashing path is proven once on the sacrificial unit.
- JTAG attach reaches a non-destructive halt/read state or is explicitly marked
  blocked with adapter, pinout, and voltage notes.

Linux board benchmark pass:

- CoreMark, STREAM, lmbench latency/bandwidth, fio, and iperf3 complete three
  consecutive runs without kernel panic, thermal shutdown, filesystem remount
  read-only, or SSH/UART loss.
- Cooling and power setup are unchanged during all comparable runs.
- Raw logs and command transcripts are retained.

Android exploratory pass:

- Android image boots to `adb devices` and produces `getprop`, `dmesg`, and
  `logcat`.
- Display or screencap evidence is captured.
- Failures in camera, GPU, NPU, CTS, VTS, or NNAPI are not project blockers for
  v0, but must be named before making any Android compatibility claim.

Fail conditions:

- No serial capture for a claimed boot or benchmark.
- Image filename, SHA256, or board revision missing.
- Board runs without required heatsink/fan during performance tests.
- Benchmark commands are modified between boards without recording the diff.
- Any result is compared to phone-class silicon above benchmark matrix L4.

## Result Record Template

```text
board:
revision:
serial_or_qr:
ram_emmc:
power_supply:
cooling:
image_url:
image_sha256:
kernel:
boot_media:
flash_method:
uart_adapter:
jtag_adapter:
logs:
benchmarks:
pass_fail:
waivers:
```

## Source References

- BeagleV-Ahead quick start and flashing:
  https://docs.beagleboard.org/boards/beaglev/ahead/02-quick-start.html
- BeagleV-Ahead design, UART, and JTAG location:
  https://docs.beagleboard.org/boards/beaglev/ahead/03-design.html
- Sipeed Lichee Pi 4A overview:
  https://wiki.sipeed.com/hardware/en/lichee/th1520/lp4a.html
- Sipeed Lichee Pi 4A image summary:
  https://wiki.sipeed.com/hardware/en/lichee/th1520/lpi4a/3_images.html
- Sipeed Lichee Pi 4A flashing:
  https://wiki.sipeed.com/hardware/en/lichee/th1520/lpi4a/4_burn_image.html
- Sipeed Lichee Pi 4A UART and JTAG:
  https://wiki.sipeed.com/hardware/en/lichee/th1520/lpi4a/6_peripheral.html
- Milk-V Meles boot guide:
  https://milkv.io/docs/meles/getting-started/boot
- Milk-V Meles installation:
  https://milkv.io/docs/meles/installation
- Milk-V Meles hardware:
  https://milkv.io/docs/meles/hardware/meles-main-board
