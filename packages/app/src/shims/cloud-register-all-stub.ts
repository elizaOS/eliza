/**
 * Build-time stub for cloud-surface registration, used when
 * `ELIZA_DISABLE_WEB_SHELL=1` excludes the cloud surface from the build. With no
 * cloud routes to register, this is a no-op.
 */
export function registerAllCloudSurfaces(): void {}
