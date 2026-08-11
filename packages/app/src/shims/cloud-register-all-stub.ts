/**
 * Build-time stub for cloud-surface registration, used when
 * `ELIZA_DISABLE_WEB_SHELL=1` excludes the cloud surface from the build. With no
 * cloud routes to register, this is a no-op.
 */
export function registerPublicCloudSurfaces(): void {}

export function registerPrivateCloudSurfaces(): Promise<void> {
  return Promise.resolve();
}

export async function registerAllCloudSurfaces(): Promise<void> {}
