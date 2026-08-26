# Experimental direct exact-window helper

This optional executable is a direct-distribution-only Computer Use component.
It dynamically probes a private SkyLight ABI, so it must never enter a Mac App
Store source manifest, build artifact, launcher route, or signed submission.

The helper is separate from the shared plugin Accessibility helper. It accepts
one JSON request, supports read-only `probe` and deterministic `recipe`
commands, and refuses `dispatch` unless the caller explicitly selects
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

Do not enable the flag for Store builds. The build command rejects that
combination, the Electrobun copy map stays empty, the source directory is absent
from its published manifest, and Store verification scans the finished app for
the component name, route, private framework path, and private symbols.

`THIRD_PARTY_NOTICES.txt` records the pinned MIT recipe and upstream
attribution. Source typecheck and deterministic tests do not replace legal and
release review, Developer ID signing/notarization, runtime capability probing,
or disposable same-PID multi-window physical acceptance.
