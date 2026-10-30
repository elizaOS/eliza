# SELinux policy

Eliza's images add no SELinux policy for the Eliza app.

The launcher is a presigned, nonprivileged product app (see
`scripts/android/image-launcher.ts`), so it runs in `untrusted_app`, not
`platform_app` or `priv_app`. The rules that used to live here allowed
`platform_app` to execute files from app data on development images. They do
not apply to an `untrusted_app` agent, and they cannot be moved to it:
`system/sepolicy/private/app_neverallows.te` forbids `execute_no_trans` on
`app_data_file` for every untrusted app above target API 28 (W^X).

The resident agent instead executes the admitted runtime installed beside the
APK, from its read-only native library directory
(`/product/app/Eliza/lib/<arch>/`, staged by `android-native-admission.mjs`).
Products without a native installation target in
`android/products/eliza-images.json` do not include the resident runtime.

A future agent domain must be added here with a compiled policy and booted
denial evidence; validate.ts refuses app-data execution rules.
