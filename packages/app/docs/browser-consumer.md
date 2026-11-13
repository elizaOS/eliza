# Branded browser consumers

`src/renderer/browser-consumer.tsx` exports the actual application, its common AppProvider/startup ports, and native bootstrap. It does not mount a React root. A product supplies its installed host ports and branding, creates `createBrowserConsumerHost(options)`, awaits `initializeBrowserConsumer(host)` before mounting, then renders `<BrowserConsumerApp host={host} />`. First-run remains the application’s real first-run flow.

Build a production artifact from a clean reviewed checkout after building its workspace dependencies:

```sh
bun run --cwd packages/app build:browser-consumer --out-dir /absolute/empty/output
```

The producer rejects dirty source by default. It records the Git revision, lock digest, every observed source/dependency digest and every output file digest. Consumers must verify the complete manifest and require the revision to match their reviewed upstream pin. Supply one shared React, React DOM and Capacitor core module instance. The manifest lists all other external type packages and exact versions; JSON type dependencies require `resolveJsonModule: true`.

Import the manifest’s `stylesEntry` once alongside its `entry`. Vite emits one ordered stylesheet that includes lazy view styles; do not select CSS by filename guesses. Stage the manifest’s `public/` files at the web root while applying explicit product branding through host data. All public assets are hash-covered.

A source-only diagnostic is available for investigation before dependencies have built distribution output:

```sh
NODE_OPTIONS="--conditions=eliza-source" bun run --cwd packages/app build:browser-consumer --out-dir /absolute/empty/diagnostic --allow-dirty-diagnostic
```

This mode is always marked non-distributable, even when the checkout happens to be clean. It is not a replacement for clean reviewed production qualification. Browser consumer diagnostics must not be admitted as a product pin or used to infer native device acceptance.

`useBrowserRuntime()` observes the mounted provider’s phase and verified runtime and exposes its existing retry action. The full internal application client and AppContext are not part of this consumer API.

The optional `permissions` host supplies installed permission methods, supported canonical IDs and the existing walkthrough memory. The application retains its one permission controller and requires an explicit tap before requesting access. Android uses the same ordered six-card flow in each product, filtered to actual supported methods. The shared immediate **Not now** action replaces Alpha's previous 20-second delay. Reviewed choices are UI memory only; platform readback remains the permission authority. Photo scope and location accuracy remain visible when access is limited.

Keep absent capabilities unavailable. The current generic Android camera request asks for multiple permissions and its photo answer does not establish library scope; it must not be used to fill a camera-only or library card. A native Calendar registration also needs its actual `requestAccess` adapter before the card can be offered.
