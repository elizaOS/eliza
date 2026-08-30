# Experimental direct exact-window helper

This optional executable is a direct-distribution-only Computer Use component.
It dynamically probes a private SkyLight ABI, so it must never enter a Mac App
Store source manifest, build artifact, launcher route, or signed submission.

The helper is separate from the shared plugin Accessibility helper. It accepts
one JSON request, supports read-only `probe`, deterministic `recipe`, and the
non-dispatching `wire-contract` diagnostic used by the cross-process test, and
refuses `dispatch` unless the caller explicitly selects
`experimental_direct_exact_window` with exact PID, CGWindowID, observation,
screen point, window-local point, and current bounds.

The direct build pipeline includes it only when both the direct variant and the
explicit component flag are supplied:

```bash
bun packages/app-core/scripts/desktop-build.mjs build \
  --build-variant=direct \
  --build-experimental-exact-window-helper
```

Runtime selection remains disabled unless
`ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW=1` is present. A click or scroll
request must also set `allowExperimentalExactWindow: true` and pass the normal
session authority plus a separate action-time approval. The direct embedded
runtime adapter resolves the fixed bundle-local sibling; packaged children
cannot choose another helper, and the shared desktop shell has no
helper-specific launcher route.

The helper and its caller run as the same desktop user. The executable is not
a privilege boundary against another process with the same UID. Packaged
resolution accepts only the fixed bundle-local sibling, and release acceptance
must verify its manifest hash, nested code signature, enclosing app signature,
and notarization before treating its receipt as authentic. Development path
overrides are operator-controlled and carry the same-UID trust assumption.
Runtime symbol presence is only a capability probe: the private SkyLight ABI
remains unsupported and may change between macOS builds.

Do not enable the flag for Store builds. The build command rejects that
combination, the Electrobun copy map stays empty, the source directory is absent
from its published manifest, and Store verification scans the finished app for
the component name, route, private framework path, and private symbols.

`THIRD_PARTY_NOTICES.txt` records the pinned MIT recipe and upstream
attribution. Source typecheck and deterministic tests do not replace legal and
release review, Developer ID signing/notarization, runtime capability probing,
or disposable same-PID multi-window physical acceptance.
