# Pixel 10a / stallion hardware composition

These hardware inputs originated in the reviewed `android/aosp/stallion` directory
at `b422af38d71bd48a122a8269ebd0824d478891e5`. The product composer now renders
`@VENDOR_DIRECTORY@` and `@PIXEL_CONFIG_MODULE@` in the device and patch templates.
Use the rendered `stallion` directory; the templates are not directly installable.

The caller supplies `vendorDirectory` and may supply `pixelConfig` with exact
`moduleName`, `packageName` and `mimeType` identities. New products default to
`PixelConfig`, `ai.eliza.hardware.pixelconfig` and
`vnd.android.cursor.dir/vnd.eliza.pixel-flags`. Existing products explicitly
retain installed identities in their own descriptor. The provider's Gservices
authority, read-only behavior and installed-system-eSIM-client restriction are
unchanged. Composition evidence binds every template input and rendered output.

The immutable source inventory still records the historical
`vendor/alphaphone/stallion/device.mk` include. Eliza's descriptor retains that
layout and its installed provider identities. Source staging rejects a different
layout; rendered patch templates do not admit changes to pinned source inputs.
A layout move needs a separately reviewed source inventory or patch admission.

Source composition, a successful product build, a real boot and release/device
qualification are separate. This directory grants none of those qualifications.
