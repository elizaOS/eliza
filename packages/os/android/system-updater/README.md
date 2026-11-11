# On-device OS updater

Candidate implementation of the approved on-device A/B update path (Alpha
[P-75](https://github.com/eliza-research/alphaphone/blob/main/docs/decisions.md) /
[issue 680](https://github.com/eliza-research/alphaphone/issues/680)). It is separate from the ordinary launcher and from the
computer-operated recovery/sideload tool. Product hosts own release enrollment.
The generic resource configuration disables every entry point and schedules
nothing. This is not yet a qualified or installed updater.

The host uses Android JobScheduler, platform OTA signature verification and
UpdateEngine. It accepts an enrolled HTTPS channel, verifies the complete package
and its signed product/device/build metadata, then passes a read-only payload
file descriptor to the engine. It does not change the launcher package or read
its private data. The small SELinux domain grants only the updater and engine
connection; payload access needs separate qualification of the exact policy.

The job requires the primary unlocked user, unmetered connectivity and enough
battery. Apply and reboot also require an idle display and no call. A stopped
download retains a content-addressed partial file and resumes with a checked
HTTP range; a server that ignores ranges starts a known-unapplied download over.
An oversized partial or a complete partial with a wrong digest is cleared under
the download lock. A later attempt can fetch the same candidate again.
If payload verification needs more free space, an unapplied candidate keeps
its journal and files. A later check can retry after space is available.
Before apply, extraction uses one private scratch file. After process death,
a matching unapplied journal can reclaim the file before the space checks. This
does not retire old downloads, verified payloads or recovery files.
When an applied update waits for restart, a later check verifies the retained
archive and payload without writing either file. Missing or invalid files keep
the candidate held for review.
The ordinary app remains nonprivileged. Android's shutdown path owns the reboot.

The durable journal records an apply intent before Binder. An unsettled apply
after process death becomes unknown; it is never silently submitted again. Only
the live owned callback records reboot readiness. Booting the exact target
fingerprint records completion. Seeing the source after reboot records source
retention, not proof of a rollback. Bad state is held for review.

Validation: the journal has source-linked Quint checks, finite-state checking
and generated traces replayed through its real Java implementation. The downloader
has real loopback HTTPS and file-backed retry/range checks with compile-only
Android ports. The host model covers interruption and fair completion after
space becomes available. Its replay runs the storage guard and failure
transition with real files and controlled host ports. These do
not prove Android execution, package-signature rejection, power/call constraints
or preservation of app data across an OS update.

Remaining gates: real Android compilation and adapter tests, interrupted/range
downloads, package and metadata rejection, permission and SELinux checks,
reviewed channel/key enrollment, a signed image, and physical wireless update,
interruption, source-retention/rollback and data-retention drills. No release
or device-acceptance flag is set by these models or helpers.

## Host decision and enrollment

The host uses the platform A/B update engine in a separate app. The existing
computer-operated recovery tool cannot provide cable-free delivery. Giving the
launcher reboot or update privileges would combine unrelated authority. The
separate host keeps those permissions and the small data directory isolated.
A discovery manifest proposes a package; Android's OTA trust store and signed
package metadata authorize its installation.

The product includes `product.mk` and supplies a reviewed resource overlay for
`os_update_manifest`, `os_update_hosts`, `os_update_product`, `os_update_device`
and `os_update_ota_certificate`. Keep `os_update_enabled` false until the exact
image, certificate, channel and device qualification are complete. The platform
signing identity must match the product's system image. No key or release URL
is supplied by this shared package.

The shared Pixel product composer accepts `systemUpdater: true` to copy this
client, its permissions and its policy into the product output. The resulting
`physical-product.json` records each staged source hash and `enabled: false`.
The option cannot carry an enrollment or enable the updater. An existing updater
staging directory is refused and preserved. Other products can still include
`product.mk` directly.
