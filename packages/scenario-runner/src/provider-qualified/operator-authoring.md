# Provider canary operator authoring

`eliza-provider-operator` prepares private input for exactly one canonical
provider canary. It does not authenticate to a provider, send ingress, execute a
controller, or create qualification evidence.

Create a starter directory:

```bash
eliza-provider-operator init ./private-gmail-canary \
  --scenario provider.gmail.confirmed-send \
  --scenarios /absolute/path/to/packages/test/scenarios/provider-qualified
```

The new directory is mode `0700`; `plan.json`, `target.json`, `input.json`,
`probes.json`, and `scenario.json` are mode `0600`. Creation refuses existing
files. Every editable value starts with `__REPLACE_WITH_` and is intentionally
invalid, so generated material cannot pass preflight or be mistaken for a
runnable target. `scenario.json` is not operator-authored: it is the canonical,
executable-free definition copied from the package's checked-in 13-canary
catalog and serialized through the strict scenario-snapshot boundary.

After replacing every placeholder with an operator-owned target, harmless
payload, two real negative-probe definitions, a pinned manifest-authority key
ID, and an HSM/offline signer name, run:

```bash
eliza-provider-operator preflight ./private-gmail-canary
```

Preflight is offline. It verifies exact file modes and names, closed document
shapes, the provider-native operation contract, two unique probe definitions,
and the complete 13-canary static inventory. Scenario modules are parsed for
metadata and never imported. Preflight does not make a canary safe to run and
does not claim operator authorization or provider qualification.

After an injected signer has written the signed authorization and the plan
points to that `0600` file, the three disjoint public-key pin sets, a reviewed
operator module plus its SHA-256 digest, a pre-existing private state directory,
and a new output directory, prepare an executable input directory:

```bash
eliza-provider-operator prepare-run \
  ./private-gmail-canary ./prepared-gmail-run
```

The command reruns preflight, creates a new `0700` directory, copies the exact
authorization, public keys, pinned module, and canonical scenario, unwraps the
validated target/input/probes into the raw shapes consumed by
`eliza-provider-canary`, and writes its exact closed v2 `config.json`. Every
prepared file is `0600`. It still performs no provider ingress; execution is an
explicit later `eliza-provider-canary ./prepared-gmail-run/config.json` step.

Applications authorize the resulting canonical manifest through
`authorizeProviderCanaryWithSigner`. Its `ProviderManifestSigner` receives only
the exact signing bytes and returns one Ed25519 signature. Private PEM strings,
key paths, credentials, and tokens are not accepted by the API or CLI. A
deployment should inject an HSM/offline implementation and then verify the
authorization against its pinned public key before any authenticated ingress.
