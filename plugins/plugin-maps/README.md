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

A host may supply `selectionPadding` for its own panels. The map samples it on
updates and idle after resize, so a selected place stays visible when panels
move. Layout changes preserve the current zoom and marker, and do not take the
camera from a route or active position following.

## Eliza Cloud Maps

With `ELIZAOS_CLOUD_API_KEY` set (and `ELIZAOS_CLOUD_BASE_URL` for a non-production
Cloud), the service registers `ElizaCloudMapsAdapter` for `/api/v1/maps/*`: place
search, details and routes with alternatives. Cloud supplies data only. The phone host
registers a `MapsDeviceNavigation` with `MapsService.registerDeviceNavigation`; the
`MAPS_SELECT` and `MAPS_NAVIGATION_START`, `_REROUTE` and `_STOP` actions ask it and
report its state. Without one they return `MAPS_DEVICE_UNAVAILABLE`. GPS, the active
route and guidance stay on the device; `MAPS_SHARE` still needs the user's confirmation.

The agent host loads Maps on mobile and lean chat profiles. A phone can offer
its navigation through the authenticated `/api/client-devices/maps-navigation`
route while it sends a conversation turn. The shared client helper binds the
offer to that turn. The host still decides whether to show a place, plan from
local GPS, ask for confirmation, reroute, or stop. No device coordinates are
returned by this relay.

Requests belong to the current authenticated conversation and device enrollment.
The relay delivers a request once and waits at most 30 seconds for its result.
Cancellation, replacement, or an uncertain response does not replay an effect.
Idle polls wait up to one second without holding a database transaction.

Cloud Maps creates one `Idempotency-Key` for each explicit POST operation.
The server consumes a separate organization Maps request allowance and makes
no per-request monetary charge (Alpha P-56). It refuses duplicate admissions,
including retries after an unknown acknowledgement. An unconfigured allowance
needs an operator configuration change; it is not a payment or upgrade prompt.
