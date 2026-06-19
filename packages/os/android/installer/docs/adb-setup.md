# ADB and Fastboot Setup

The installer uses Android platform tools only:

- `adb` for booted Android discovery and post-flash validation.
- `fastboot` for bootloader-side preflight and flashing.

The scripts are conservative, but platform tools still talk to real devices.
Run dry-run plans before adding any execution flags.

## Install Platform Tools

### macOS

```bash
brew install android-platform-tools
adb version
fastboot --version
```

### Linux

Install the distribution package or Google's platform-tools zip. Package names
vary by distribution:

```bash
sudo apt-get install android-tools-adb android-tools-fastboot
adb version
fastboot --version
```

Linux hosts may also need udev rules so non-root users can access USB devices.
After adding rules, reload udev and reconnect the device:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
adb kill-server
adb start-server
adb devices -l
```

### Windows

Install Google's Android SDK Platform-Tools zip or Android Studio. Add the
platform-tools directory to `PATH`, then verify from PowerShell:

```powershell
adb version
fastboot --version
adb devices -l
```

The PowerShell wrapper in this folder calls the Bash installer through a local
Bash runtime. Git for Windows and WSL both provide practical options.

## Device Preparation

1. Enable Developer options on the device.
2. Enable USB debugging.
3. Connect over USB and accept the device authorization prompt.
4. Verify exactly one authorized device is visible:

```bash
adb devices -l
```

Expected state:

```text
SERIAL    device usb:... product:... model:... device:...
```

States that block flashing:

- `unauthorized`: accept the USB debugging prompt, then reconnect.
- `offline`: reconnect USB, restart ADB, or change cables/ports.
- Multiple `device` rows: pass `--device SERIAL`.

## Bootloader Requirements

The installer never unlocks a bootloader. Unlocking is device-specific, usually
wipes user data, and can affect warranty or enterprise enrollment.

Before flashing, confirm:

- The device model is intentionally supported by the release manifest.
- The bootloader is manually unlocked.
- Required user data is backed up.
- The host can see the device in bootloader mode:

```bash
adb reboot bootloader
fastboot devices
fastboot getvar unlocked
```

`fastboot getvar unlocked` must report `yes` or `true` before this installer
will execute flashing commands.

## Troubleshooting

- Prefer known-good USB-C data cables; charge-only cables often fail.
- Avoid USB hubs when flashing.
- Restart the ADB server after changing drivers or udev rules:

```bash
adb kill-server
adb start-server
```

- On Windows, install the OEM USB driver when `adb devices -l` is empty.
- On Linux, re-check udev rules when `adb` works only with `sudo`.
