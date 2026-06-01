# @elizaos/capacitor-location

Capacitor plugin for geolocation within elizaOS apps. Provides current position, continuous location watching, and permission management across browser, iOS, and Android.

## Capabilities

- **Get current position** — one-shot GPS/network fix with configurable accuracy and timeout
- **Watch position** — continuous location stream with distance and interval throttling
- **Permission management** — check and request OS location permissions
- **Cross-platform** — identical TypeScript API on web (Geolocation API), iOS (CoreLocation), and Android (FusedLocationProviderClient)

## Installation

```bash
npm install @elizaos/capacitor-location
npx cap sync
```

## Usage

```typescript
import { Location } from '@elizaos/capacitor-location';

// Get current position
const result = await Location.getCurrentPosition({ accuracy: 'high', timeout: 10000 });
console.log(result.coords.latitude, result.coords.longitude);

// Watch position changes
const { watchId } = await Location.watchPosition({ accuracy: 'high', minDistance: 10 });
await Location.addListener('locationChange', (location) => {
  console.log('New position:', location.coords);
});

// Stop watching
await Location.clearWatch({ watchId });

// Permissions
const status = await Location.checkPermissions();
if (status.location !== 'granted') {
  await Location.requestPermissions();
}
```

## API

### `getCurrentPosition(options?)`

Returns a single `LocationResult` with the device's current coordinates.

Options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accuracy` | `"best"\|"high"\|"medium"\|"low"\|"passive"` | `"high"` | Desired fix accuracy |
| `maxAge` | `number` (ms) | `0` | Return cached location if younger than this |
| `timeout` | `number` (ms) | `10000` | Abort if no fix within this window |

### `watchPosition(options?)`

Starts continuous location updates. Returns `{ watchId: string }`. Location updates are delivered via the `locationChange` event. Stop with `clearWatch`.

Additional options beyond `getCurrentPosition`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minDistance` | `number` (m) | `0` | Minimum movement before firing an update |
| `minInterval` | `number` (ms) | `0` | Minimum time between updates |

### `clearWatch({ watchId })`

Stops a running watch by its ID.

### `checkPermissions()`

Returns `LocationPermissionStatus` without prompting. Fields: `location` and `background` (iOS/Android only), each `"granted" | "denied" | "prompt"`.

### `requestPermissions()`

Requests OS location permission. On web, this implicitly triggers a `getCurrentPosition` call (the only way browsers expose the permission prompt).

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `locationChange` | `LocationResult` | Fired on each position update while watching |
| `error` | `LocationErrorEvent` | Fired on location errors |

`LocationErrorEvent.code` values: `PERMISSION_DENIED`, `POSITION_UNAVAILABLE`, `TIMEOUT`, `UNKNOWN`.

## Platform setup

### iOS

Add to `Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>This app uses your location to …</string>

<!-- Only if requesting "always" permission -->
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>This app uses your location in the background to …</string>
```

Minimum deployment target: iOS 13.0.

### Android

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />

<!-- Only if background location is needed -->
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
```

Requires Google Play Services (`com.google.android.gms:play-services-location`).

## Building

```bash
bun run build        # tsc + rollup
bun run build:docs   # regenerate README from JSDoc, then build
bun run clean        # remove dist/
```

## License

MIT
