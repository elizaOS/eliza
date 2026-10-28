/** Desktop password-manager CLIs are not a mobile credential provider. */
import type { ActionResult } from "@elizaos/core";

export async function runPasswordManagerHandler(): Promise<ActionResult> {
  return {
    success: false,
    text: "This desktop password-manager integration is unavailable on mobile.",
    data: { actionName: "PASSWORD_MANAGER", error: "CAPABILITY_UNAVAILABLE" },
  };
}
