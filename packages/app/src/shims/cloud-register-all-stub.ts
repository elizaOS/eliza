/**
 * Build-time stub for cloud-surface registration, used when
 * `ELIZA_DISABLE_WEB_SHELL=1` excludes the cloud surface from the build. With no
 * cloud routes to register, this is a no-op.
 *
 * Mirrors the real public contracts:
 * - `@elizaos/ui/cloud/register-all` → sync `registerAllCloudSurfaces(): void`
 * - `@elizaos/ui/cloud/register-public` → progressive public-only boot
 */

export function registerAllCloudSurfaces(): void {}

export function registerPublicCloudSurfaces(): void {}

export function registerPrivateCloudSurfaces(): Promise<void> {
  return Promise.resolve();
}

export function ensurePrivateCloudSurfaces(): Promise<void> {
  return Promise.resolve();
}
