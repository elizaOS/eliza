# @elizaos/plugin-spotify

Spotify music integration for elizaOS agents: search, saved-track library,
playlists, playback control, and device handoff, exposed through the single
`SPOTIFY` umbrella action.

## Credential modes

- **Managed OAuth (cloud / app):** the plugin registers a
  `ConnectorAccountProvider` with the runtime's `ConnectorAccountManager`. The
  generic connector-account HTTP surface drives a PKCE authorization-code flow
  against `accounts.spotify.com`; tokens are persisted behind vault refs (never
  in account metadata, logs, or model context) and refreshed on expiry or 401.
  Disconnect/revoke invalidates the service's cached tokens.
- **Local mode (self-hosted):** configure `SPOTIFY_CLIENT_ID`,
  `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN` (obtained via a one-time
  authorization-code grant on your own Spotify app). No connector manager or
  database is required.

## Settings

| Setting | Purpose |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | Spotify app client ID (local mode; also used to refresh managed grants self-hosted) |
| `SPOTIFY_CLIENT_SECRET` | Spotify app client secret |
| `SPOTIFY_REFRESH_TOKEN` | Long-lived refresh token for local mode |
| `SPOTIFY_REDIRECT_URI` | OAuth redirect URI registered on the Spotify app |

## Behavior notes

- Playback control (`play`, `pause`, `next`, `previous`, `transfer`) is
  premium-gated by Spotify; free-tier accounts receive a distinct
  `SPOTIFY_PREMIUM_REQUIRED` failure, and a missing player surfaces
  `SPOTIFY_NO_ACTIVE_DEVICE` with a device-handoff hint.
- 429 responses map to `SPOTIFY_RATE_LIMITED` and carry the parsed
  `Retry-After` seconds in error context.
- List operations are offset-paged; results report `nextOffset` when more data
  exists.

## Spotify app registration (human-only)

Create an app at <https://developer.spotify.com/dashboard>, add the redirect
URI, and copy the client ID/secret into the settings above. Spotify requires
each end user to be allow-listed on apps in Development Mode.

## Development

```bash
bun run --cwd plugins/plugin-spotify test
bun run --cwd plugins/plugin-spotify typecheck
bun run --cwd plugins/plugin-spotify lint:check
```
