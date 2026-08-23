/** Build-time configuration shared by realtime voice routing and eligibility. */

/** True only for builds explicitly armed to use the local voice gateway. */
export function isRealtimeVoiceForceEnabled(): boolean {
  try {
    const raw = import.meta.env?.VITE_VOICE_REALTIME_FORCE as unknown;
    if (typeof raw !== "string") return false;
    const value = raw.trim().toLowerCase();
    return (
      value === "1" || value === "true" || value === "yes" || value === "on"
    );
  } catch {
    // error-policy:J4 An unreadable build flag leaves force-arming disabled.
    return false;
  }
}
