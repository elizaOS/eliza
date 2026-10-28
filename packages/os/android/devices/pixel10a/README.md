# Pixel 10a / stallion hardware composition

These device, policy, stock-kernel and eSIM-provider inputs were moved unchanged
from Alpha Phone's reviewed `android/aosp/stallion` directory at
`b422af38d71bd48a122a8269ebd0824d478891e5`. Their hardware behavior is common to
both products. The shared product composer generates only product branding and
registration from `android/products/pixel10a-*.json`.

The generated source inventory still includes a reference to
`vendor/alphaphone/stallion/device.mk`; stage this directory at that compatibility
path for either launcher. Retained Alpha module/package names in the eSIM flags
provider are internal names, not the launcher identity. The provider remains
read-only, networkless and restricted to installed system eSIM clients.

Source composition, a successful product build, a real boot and release/device
qualification are separate. This directory grants none of those qualifications.
