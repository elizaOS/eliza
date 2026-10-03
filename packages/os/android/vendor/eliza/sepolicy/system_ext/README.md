# System_ext SELinux policy (GSI products)

Included by `SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS` in `eliza_common.mk` when a
product sets `ELIZA_GSI := true`. A GSI runs on a third-party vendor partition,
so policy in the parent vendor directory would not ship. Soong globs each policy
directory non-recursively, so this directory is not compiled into vendor policy
for the Cuttlefish and Pixel products.

The rules must compile on every GSI source profile (Android 15, 16 and 17), so
they name only `platform_app`. Android 17's `platform_app_36` rules live in
`../system_ext_api37/`. They are `userdebug_or_eng` only;
a production `user` GSI stays blocked until the agent no longer executes app
data. Validate changes through the full [AOSP build](../../../../README.md);
installer frontend tests do not compile SELinux policy.
