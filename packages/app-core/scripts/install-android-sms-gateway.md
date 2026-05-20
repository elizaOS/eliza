# Android SMS Gateway Install Smoke

The Android SMS gateway APK is built with:

```sh
set -a; source .eliza-local/bluebubbles-bridge.env; set +a
export ELIZA_MOBILE_SKIP_WEB_BUILD=1
export ELIZA_ANDROID_SMS_GATEWAY_ENABLED=true
export ELIZA_ANDROID_SMS_GATEWAY_SECRET="$BLUEBUBBLES_GATEWAY_SECRET"
export ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL='https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles'
export ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER='+14159611510'
export ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL='Eliza Cloud Gateway (+14159611510)'
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
node packages/app-core/scripts/run-mobile-build.mjs android-sms-gateway
```

Install and diagnose the current APK once an Android phone is visible in
`adb devices -l`:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs \
  --grant-role \
  --clear-logcat \
  --logcat-lines 200
```

By default the installer uses `packages/app/android/.../app-debug.apk` when it
exists, then falls back to the preserved artifact at
`.eliza-local/artifacts/eliza-android-sms-gateway-debug.apk`.

Check the path that will be installed without requiring a connected device:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs --print-apk
```

Check local readiness without requiring a connected phone:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs --doctor
```

`--doctor` also sends a gateway-shaped smoke payload to the production cloud
webhook when `BLUEBUBBLES_GATEWAY_SECRET` is available in the environment or in
`.eliza-local/bluebubbles-bridge.env`; it does not print the secret. On macOS,
it also reports whether any USB phone-like device is visible to the host so an
empty `adb devices` result can be separated from a cabling/trust issue.

If the phone is on the same network but does not appear in `adb devices -l`,
open Android Developer Options > Wireless debugging > Pair device with pairing
code. Leave that pairing screen open, then run:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs \
  --pair auto \
  --connect auto \
  --wait-device 60 \
  --grant-role \
  --clear-logcat \
  --watch-logs 60
```

The command waits up to 60 seconds for the phone to advertise the
`_adb-tls-pairing._tcp` endpoint and prompts for the six-digit code. For
non-interactive shells, pass `--pair-code '<six-digit-code-from-phone>'` or set
`ADB_PAIR_CODE`.

`--pair auto` uses the `_adb-tls-pairing._tcp` service advertised while the
pairing dialog is open. `--connect auto` uses the `_adb-tls-connect._tcp`
service advertised by Wireless debugging after pairing.

Wait for a phone to appear, then install, request the SMS role, and watch logs:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs \
  --wait-device 300 \
  --grant-role \
  --clear-logcat \
  --watch-logs 60
```

Capture the current readiness state across Android and BlueBubbles:

```sh
node packages/app-core/scripts/check-sms-gateway-readiness.mjs
```

Wait until either an Android device appears or BlueBubbles outbound becomes
ready:

```sh
node packages/app-core/scripts/watch-sms-gateway-readiness.mjs
```

When BlueBubbles becomes ready, the watch command points at the strict
BlueBubbles verifier rather than directly retrying the queue, so the send and
pending-count decrease are both checked.

To automatically run the Android install/watch flow when one adb device appears:

```sh
node packages/app-core/scripts/watch-sms-gateway-readiness.mjs --run-install
```

Strict physical verification for the Android path:

```sh
node packages/app-core/scripts/verify-android-sms-gateway-e2e.mjs
```

This command only passes after logcat shows an actual inbound SMS delivery,
gateway work being queued, the cloud webhook accepting the message, and an
outbound reply being sent and persisted.

Strict queued-reply verification for the BlueBubbles path:

```sh
node packages/app-core/scripts/verify-bluebubbles-gateway-e2e.mjs
```

This command checks `http://127.0.0.1:8795/doctor` first and exits before
calling the retry endpoint unless BlueBubbles outbound is ready. It ignores the
`pending-replies` doctor status because pending work is required for the
verification. It only passes after a queued reply is sent and the pending-reply
count decreases.

If Android does not grant the default SMS role from `cmd role`, set Eliza as the
default SMS app in Android Settings, then rerun:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs \
  --skip-install \
  --clear-logcat \
  --logcat-lines 200
```

For a physical end-to-end proof, send a real SMS to `+14159611510` from another
phone and watch the gateway logs:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs \
  --skip-install \
  --watch-logs 60
```

Successful logs should show:

- `ElizaSmsReceiver` receives and persists the inbound message.
- `ElizaSmsGateway` queues gateway work.
- `ElizaSmsGateway` receives HTTP success from the cloud gateway.
- `ElizaSmsGateway` sends and persists the reply SMS.

Emulators can exercise the receiver path, but they do not prove the production
phone number or carrier send path:

```sh
node packages/app-core/scripts/install-android-sms-gateway.mjs \
  --grant-role \
  --clear-logcat \
  --simulate +14155550123 \
  --message "hello eliza" \
  --logcat-lines 200
```
