# @elizaos/plugin-maps

Provider-neutral maps domain for elizaOS agents: place lookup, route planning, saved
places, safe sharing, and navigation handoffs.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-maps build  # build
bun run --cwd plugins/plugin-maps test   # tests
```

The `./client` entry exposes host-configured device controllers and contracts.
Use `./client/map-plane` for the optional MapLibre renderer and supply its worker,
fonts, colors, regional transport and protocol. Native location uses the host
bridge supplied to `./client/native-location`; no plugin registry or provider
authority is chosen by the client library. Callers cancel regional requests and
retire location ownership; the library does not impose elapsed-time deadlines.

Device navigation exposes provider-reported maneuvers, route progress, origin
search, saved-place matches and explicit rerouting. Route projection uses the
short great-circle segments, including routes across the date line. The optional
map plane draws selectable pins and a moving-device heading, and can follow the
position during navigation. Hosts still own location permission, voice policy,
provider configuration and presentation.
