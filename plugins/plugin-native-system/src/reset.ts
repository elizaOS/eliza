/**
 * Renderer contract for the native data reset (`reset.DataResetPlugin` on Android).
 *
 * The renderer only asks for the native review. It carries no reset authority: the native
 * disclosure and a fresh Android device-credential confirmation decide, and a confirmed reset
 * stops the app instead of resolving. Every result that reaches the renderer therefore means
 * nothing was reset, and this module never reports a completed deletion.
 */

/** Native outcomes that reach the renderer. Neither one means data was deleted. */
export type DataResetReviewStatus = "cancelled" | "unavailable";

export interface DataResetReviewResult {
  status: DataResetReviewStatus;
  message: string;
}

/** Bridge shape of a host's registered `DataResetPlugin` subclass. */
export interface DataResetPlugin {
  review(): Promise<{ status?: unknown; message?: unknown }>;
}

/** Shown when the review could not open or its result was malformed. */
export const DATA_RESET_UNCONFIRMED =
  "Reset could not be opened. No completed reset is confirmed.";

/**
 * Opens the native review and returns its result. A rejected call, a malformed answer or any
 * status other than the two the native side sends reads as unavailable; nothing here can turn a
 * renderer value into a claim that data was erased.
 */
export async function reviewDataReset(
  plugin: DataResetPlugin | null | undefined,
): Promise<DataResetReviewResult> {
  if (!plugin)
    return { status: "unavailable", message: DATA_RESET_UNCONFIRMED };
  try {
    const value = await plugin.review();
    const status = value?.status;
    const message = value?.message;
    if (
      (status === "cancelled" || status === "unavailable") &&
      typeof message === "string" &&
      message.trim().length > 0 &&
      message.length <= 500
    ) {
      return { status, message };
    }
  } catch {
    // A rejected review is treated like a malformed one below.
  }
  return { status: "unavailable", message: DATA_RESET_UNCONFIRMED };
}
