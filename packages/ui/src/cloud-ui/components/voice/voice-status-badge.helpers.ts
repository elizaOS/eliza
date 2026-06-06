/**
 * Non-component helper for the voice status surface. Kept out of
 * voice-status-badge.tsx so that file exports only the React component and
 * stays React Fast Refresh-compatible.
 */

export function getEstimatedReadyMessage(voice: {
  cloneType: "instant" | "professional";
  createdAt: Date | string;
  name: string;
}): string {
  if (voice.cloneType === "instant") {
    return `"${voice.name}" is ready to use.`;
  }

  // Professional voice
  const createdAt = new Date(voice.createdAt);
  const now = new Date();
  const minutesElapsed = Math.max(
    0,
    (now.getTime() - createdAt.getTime()) / 1000 / 60,
  );

  const minMinutes = 30;
  const maxMinutes = 60;

  if (minutesElapsed < minMinutes) {
    return `"${voice.name}" is being processed. Professional voice clones typically take 30-60 minutes. Please check back later or click "Refresh" to see if it's ready.`;
  }

  if (minutesElapsed < maxMinutes) {
    return `"${voice.name}" should be ready soon. Click "Refresh" to check status.`;
  }

  return `"${voice.name}" should be ready now. Click "Refresh" to verify.`;
}
