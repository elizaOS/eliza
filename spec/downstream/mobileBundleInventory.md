# AlphaPhone mobile bundle dependency inventory

AlphaPhone's `scripts/agent-bundle-dependencies.ts` imports
`readMobileBundleDependencies` from
`packages/agent/scripts/mobile-bundle-dependencies.ts` at Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. Its staged artifact carries
`agent-bundle-dependencies.json`. [Source integrity](./mobileSourceIntegrity.md)
owns admission of the prepared workspace.

## Story: Attribute the dependencies that actually contributed to the packaged agent

### Contributing inputs identify exact in-root package manifests

The producer examines the bundler input table. A package contributes only
through a dependency path with positive emitted bytes. Its lexical path
identifies the package row, while the resolved path must be inside the
reviewed repository. A hoisted alias and a store path are different row
identities even if they resolve to one package. Deduplicate by the exact
canonical lexical directory and sort the resulting manifest rows. Each row
records directory, package name and version, and SHA-256 of the complete
package.json bytes. Refuse a resolved escape, unparsable package manifest,
missing identity, or no contributing package. Directory normalization,
sorting and hashing are port operations. The model defines which observed
paths and manifest identities can contribute.

```quint
type BundleInput = { dependencyPath: bool, emittedBytes: int, resolvedInside: bool, canonicalPath: bool, manifestReadable: bool, name: str, version: str }
type InputDisposition = IgnoreInput | RejectInput | IncludeInput
pure def bundleInput(input: BundleInput): InputDisposition =
  if (input.emittedBytes <= 0 or not(input.dependencyPath)) IgnoreInput
  else if (input.resolvedInside and input.canonicalPath and input.manifestReadable and input.name != "" and input.version != "") IncludeInput
  else RejectInput
pure val inputValues = Set(
  { dependencyPath: true, emittedBytes: 1, resolvedInside: true, canonicalPath: true, manifestReadable: true, name: "package", version: "1" },
  { dependencyPath: true, emittedBytes: 0, resolvedInside: false, canonicalPath: false, manifestReadable: false, name: "", version: "" },
  { dependencyPath: true, emittedBytes: 8, resolvedInside: false, canonicalPath: true, manifestReadable: true, name: "package", version: "1" })
pure def lawContributionNeedsBytesAndCustody(input: BundleInput): bool =
  bundleInput(input) == IncludeInput implies input.emittedBytes > 0 and input.dependencyPath and input.resolvedInside and input.canonicalPath
pure def lawEscapingEmittedInputRejects(input: BundleInput): bool =
  (input.dependencyPath and input.emittedBytes > 0 and not(input.resolvedInside)) implies bundleInput(input) == RejectInput
```

### The staged inventory must match the complete producer evidence

The consumer reads the producer's Android plugin manifest for
`agent-bundle.js`. The version-one inventory's bundle digest must match
the exact staged bundle. Rows are nonempty with unique canonical
directories. Reopen each manifest under the prepared source root to
confirm its name, version and raw-byte digest. Alpha's staged JSON must
equal the complete decoded producer inventory. A self-consistent subset
cannot substitute for the producer output. The inventory evidence belongs
to the named bundle. A later changed digest requires new verification.
The port supplies duplicate, path and equality observations from the
complete decoded records.

```quint
type BundleEvidence = { bundleDigest: str, producerDigest: str, formatOne: bool, androidManifest: bool, bundleEntryExact: bool, count: int, uniqueDirectories: bool, exactPackageMetadata: bool, stagedInventoryExact: bool }
pure def admitBundleEvidence(evidence: BundleEvidence): bool =
  evidence.bundleDigest != "" and evidence.bundleDigest == evidence.producerDigest and
  evidence.formatOne and evidence.androidManifest and evidence.bundleEntryExact and evidence.count > 0 and
  evidence.uniqueDirectories and evidence.exactPackageMetadata and evidence.stagedInventoryExact
pure val evidenceValues = Set(
  { bundleDigest: "sha-a", producerDigest: "sha-a", formatOne: true, androidManifest: true, bundleEntryExact: true, count: 2, uniqueDirectories: true, exactPackageMetadata: true, stagedInventoryExact: true },
  { bundleDigest: "sha-b", producerDigest: "sha-a", formatOne: true, androidManifest: true, bundleEntryExact: true, count: 2, uniqueDirectories: true, exactPackageMetadata: true, stagedInventoryExact: true },
  { bundleDigest: "sha-a", producerDigest: "sha-a", formatOne: true, androidManifest: true, bundleEntryExact: true, count: 1, uniqueDirectories: true, exactPackageMetadata: true, stagedInventoryExact: false })
pure def lawInventoryNeedsExactBundle(evidence: BundleEvidence): bool =
  admitBundleEvidence(evidence) implies evidence.bundleDigest == evidence.producerDigest
pure def lawInventoryNeedsCompleteProducer(evidence: BundleEvidence): bool =
  admitBundleEvidence(evidence) implies evidence.stagedInventoryExact and evidence.uniqueDirectories and evidence.count > 0
```
