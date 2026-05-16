# Supported Devices

Support is release-manifest driven. A device is supported only when the Android
release manifest names its codename and the artifact set was validated for that
codename.

## Support Tiers

| Tier | Meaning | Flashing guidance |
| --- | --- | --- |
| `lab-validated` | A maintainer flashed the release on this codename and completed post-flash validation. | Eligible for normal installer use. |
| `candidate` | Build artifacts exist and basic dry-run checks pass, but a full flash validation is pending. | Dry-run only unless a release owner approves lab testing. |
| `manual` | Artifacts are useful for development but no automated support is promised. | Manual fastboot workflow only. |
| `blocked` | Known incompatible, locked, or unsafe target. | Do not flash. |

## Minimum Device Criteria

A release may list stricter requirements, but supported devices generally need:

- Unlockable bootloader.
- ADB authorization from a booted Android state or a known bootloader serial.
- Fastboot support for every partition in the manifest.
- Slot behavior matching the manifest (`a`, `b`, or `none`).
- Dynamic partition handling matching the artifact set.
- Recovery path documented for stock images or a previous known-good release.

Carrier-locked or enterprise-managed devices often fail the bootloader
requirement even when their retail model name matches a supported device.

## Manifest Entries

Each release manifest should include one entry per supported codename:

```json
{
  "codename": "caiman",
  "marketingName": "Pixel 9 Pro",
  "tier": "candidate",
  "slots": ["a", "b"],
  "dynamicPartitions": true,
  "rollbackSupported": true,
  "notes": "Example only. Promote to lab-validated after a real flash pass."
}
```

Use codenames from `adb shell getprop ro.product.device` or
`fastboot getvar product`, not marketing names, as the installer target key.

## Adding a Device to a Release

1. Add the codename to the release manifest.
2. Confirm every required artifact is present and hashed.
3. Run manifest validation.
4. Run the installer dry-run with `--artifact-dir` or explicit `--image`
   mappings.
5. Flash only on lab hardware with an unlocked bootloader.
6. Run post-flash validation and capture the property output.
7. Promote the tier to `lab-validated` only after validation passes.
