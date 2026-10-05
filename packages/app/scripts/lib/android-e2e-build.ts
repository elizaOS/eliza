/** Selects the Android APK build lane that matches the E2E runtime backend. */
export function resolveAndroidE2eBuildScript(backend) {
  return backend === "host" ? "build:android:host-e2e" : "build:android";
}
