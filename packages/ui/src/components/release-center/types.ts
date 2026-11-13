/** Shared shape for the Release Center: app release status. */
export type AppReleaseStatus = {
  currentVersion?: string;
  latestVersion?: string | null;
  channel?: string | null;
  lastCheckAt?: string | number | null;
  updateAvailable?: boolean;
};
