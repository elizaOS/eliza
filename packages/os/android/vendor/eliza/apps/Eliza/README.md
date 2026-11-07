# Eliza image APK build output

`build:android:system` writes the unsigned `Eliza.apk` here. It is an input,
not a Soong module, and it is not copied into the AOSP checkout.

Sign it with the release signer (or, for development images, a developer key),
then stage the signed APK with `scripts/android/image-launcher.ts`. Staging pins
its hash and certificate and writes `vendor/eliza/launcher/`, the nonprivileged
product launcher the image installs.
