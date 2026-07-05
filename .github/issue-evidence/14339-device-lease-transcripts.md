# Device lease lock evidence for #14339

Host: `BEAST`
Device: Pixel 6a `27051JEGR10034`
Date: July 5, 2026

## Focused validation

```text
$ bun run --cwd packages/app test -- scripts/device-lease.test.mjs scripts/devices-status.test.mjs scripts/ios-e2e-lib.test.mjs
Test Files  3 passed (3)
Tests       54 passed (54)
```

```text
$ bunx @biomejs/biome check packages/app/scripts/lib/device-lease.mjs packages/app/scripts/device-lease.test.mjs packages/app/scripts/android-e2e.mjs packages/app/scripts/ios-e2e.mjs packages/app/scripts/ios-e2e-lib.mjs packages/app/scripts/ios-e2e-lib.test.mjs packages/app/scripts/lib/android-device.mjs packages/app/scripts/devices-status.mjs packages/app/scripts/devices-status.test.mjs packages/app/scripts/lib/devices-status.mjs
Checked 10 files in 45ms. No fixes applied.
```

```text
$ node --check packages/app/scripts/android-e2e.mjs
$ node --check packages/app/scripts/ios-e2e.mjs
$ node --check packages/app/scripts/ios-e2e-lib.mjs
$ node --check packages/app/scripts/lib/android-device.mjs
$ node --check packages/app/scripts/lib/devices-status.mjs
$ node --check packages/app/scripts/lib/device-lease.mjs
$ node --check packages/app/scripts/devices-status.mjs
```

## Active contention

A holder process acquired the attached Android device lease and kept it open:

```text
[holder] device lease acquired: android:27051JEGR10034
LEASE_READY /tmp/tmp.qoEYzv18wr/android:27051JEGR10034.json
```

A second process against the same device failed immediately with `waitMs: 0`:

```text
CONTENDER_FAILED device android:27051JEGR10034 leased by pid 3651797 session evidence-holder-long; waited 0ms
```

After the holder released the lease, status returned no active lease:

```text
[holder] device lease released: android:27051JEGR10034
LEASE_RELEASED
```

## Held lease shown in devices:status

```text
$ ELIZA_DEVICE_LEASE_DIR=/tmp/tmp.qoEYzv18wr bun run --cwd packages/app devices:status
PLATFORM    DEVICE             KIND    BUILD         COMMIT        DEVELOP       VERDICT  LEASE        REASON
--------    ------             ----    -----         ------        -------       -------  -----        ------
android     27051JEGR10034     device  5c05ab1770dd  3403f9bc241f  2c1f4301e4a3  STALE    pid 3651797  installed 3403f9bc241f != develop 2c1f4301e4a3
ios-sim     iOS simulator n/a  n/a     -             -             2c1f4301e4a3  UNKNOWN  -            no installed renderer stamp
ios-device  physical iOS n/a   n/a     -             -             2c1f4301e4a3  UNKNOWN  -            no installed renderer stamp
```

Screenshot artifact: `.github/issue-evidence/14339-device-lease-status-held.png`

## Pid-death reclaim

The lease file was seeded with PID `99999999`; the next acquire reclaimed it as
pid-dead and wrote the current holder.

```text
[reclaim] reclaiming pid-dead device lease: android:27051JEGR10034
[reclaim] device lease acquired: android:27051JEGR10034
{
  "deviceKey": "android:27051JEGR10034",
  "pid": 3654222,
  "sessionId": "reclaimer",
  "acquiredAt": "2026-07-05T23:36:02.232Z",
  "ttlMs": 1800000,
  "hostname": "BEAST"
}
[reclaim] device lease released: android:27051JEGR10034
```

## Full Android e2e blocker

The full `android-e2e` install/readback lane is currently blocked before APK
generation by the local missing arm64 fused inference artifact:

```text
[copyForkLlamaLib] no fused inference lib for arm64-v8a
Run packages/app-core/scripts/aosp/compile-libllama.mjs --target android-arm64-vulkan-fused
or set -Peliza.mtp.android.libdir / ELIZA_MTP_ANDROID_LIBDIR.
```
