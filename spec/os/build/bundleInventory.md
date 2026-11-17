# Resident bundle dependency inventory

The agent bundle shipped to a device carries an inventory of the packages
that contributed to it, and a consumer's build stages the inventory beside
the bundle. [Source integrity](./sourceIntegrity.md) owns
admission of the prepared workspace.

## Story: Attribute the dependencies that actually contributed to the packaged agent

> As a device owner, I can see exactly which packages went into the agent
> bundle shipped to my device.

### Contributing inputs identify exact in-root package manifests

A package contributes only through a dependency path that emitted bytes
into the bundle, and its resolved path must lie inside the reviewed
repository. Each contributing package is one row, by its exact lexical
directory, with its name, version and a digest of its whole manifest. An
input that escapes the repository or whose manifest cannot be read or
names no package refuses the inventory.

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
pure def lawEscapingEmittedInputRejects(input: BundleInput): bool =
  (input.dependencyPath and input.emittedBytes > 0 and not(input.resolvedInside)) implies bundleInput(input) == RejectInput
```

### The staged inventory must match the complete producer evidence

The inventory belongs to one bundle: its bundle digest must equal the
staged bundle's, its rows must be nonempty with unique directories, each
row's manifest must still match, and the staged inventory must equal the
producer's complete output. A self-consistent subset never substitutes
for it, and a changed bundle needs a new inventory.

```quint
type BundleEvidence = { bundleDigest: str, producerDigest: str, formatOne: bool, androidManifest: bool, bundleEntryExact: bool, count: int, uniqueDirectories: bool, exactPackageMetadata: bool, stagedInventoryExact: bool }
pure def admitBundleEvidence(evidence: BundleEvidence): bool =
  evidence.bundleDigest != "" and evidence.bundleDigest == evidence.producerDigest and
  evidence.formatOne and evidence.androidManifest and evidence.bundleEntryExact and evidence.count > 0 and
  evidence.uniqueDirectories and evidence.exactPackageMetadata and evidence.stagedInventoryExact
```
