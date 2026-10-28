# @elizaos/plugin-maps

Provider-neutral maps domain for elizaOS agents: place lookup, route planning, saved
places, safe sharing, and navigation handoffs.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-maps build  # build
bun run --cwd plugins/plugin-maps test   # tests
```

The `./client` entry exposes host-configured device controllers and contracts,
including the account-bound Cloud Maps device provider (`cloud-provider`,
`cloud-session`), the phone's `MapsDeviceNavigation` binding (`device-navigation`,
`agent-navigation`), screen-off navigation sessions (`background-navigation`) and
turn-by-turn presentation (`guidance`, `navigation-fix`).
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

## Phone Maps screen

`MapsScreenController` (`./client/maps-screen`) is the phone Maps screen without
markup: search and coordinate pins, place detail with saved places and renaming,
directions from an explicit origin, provider-limited travel modes, foreground
guidance from fresh precise fixes, explicit reroute, screen-off sessions, voice,
sharing, cross-app hand-offs (for example a Calendar event's location, with Back
to that event) and the agent's `MapsNavigationSurface`. A host renders `view()`
in its own markup and supplies the platform ports: provider connection, location,
voice, screen-off session, share sheet, website opening and agent context.
`createMapsScreen` adds a change subscription, and the `./screen` entry exports
`MapsScreen`, a React rendering of the same controller. Hosts theme it with
`--maps-*` custom properties (`--maps-bg`, `--maps-fg`, `--maps-accent`,
`--maps-font`, …) and their own icon paths, and supply the map plane. The screen
never invents a place, route, arrival time or location.

## Eliza Cloud Maps

With `ELIZAOS_CLOUD_API_KEY` set (and `ELIZAOS_CLOUD_BASE_URL` for a non-production
Cloud), the service registers `ElizaCloudMapsAdapter` for `/api/v1/maps/*`: place
search, details, reverse geocoding (`MAPS` place with only coordinates) and routes
with alternatives. Cloud supplies data only. Cloud's operator chooses the data
provider: the adapter binds its attribution and travel modes from `capabilities`,
refreshes the service's provider description when they change, and refuses a
response from a provider that changed after that read. `MAPS_COVERAGE` reads
`capabilities` afresh (Cloud does not count it against the Maps allowance) and
states the covered regions and dataset revision, travel modes and alternatives,
what is not served (live traffic, transit schedules, offline use) and who receives
search text and coordinates; a provider without coverage is reported as such. A
malformed coverage fact is dropped and never refuses a search or route. The phone host
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
