import { dbWrite } from "../../../db/client";
import { extractBody } from "../../utils/google-mcp-shared";
import { normalizeGoogleGmailMessage, normalizeManagedGmailBodyText } from "./gmail";
import { InboxGoogleProvider } from "./inbox-provider";
import { InboxContractError, InboxReceipts } from "./inbox-receipts";
import { getGoogleAccessToken, getManagedGoogleConnectorStatus } from "./shared";

export const managedInboxReceipts = new InboxReceipts(async (query) => {
  const result = await dbWrite.execute(query);
  return {
    rows: (Array.isArray(result) ? result : result.rows) as Record<string, unknown>[],
  };
});
export const managedInboxProvider = new InboxGoogleProvider({
  async grant(owner) {
    const args = { ...owner, side: "owner" as const },
      status = await getManagedGoogleConnectorStatus(args);
    if (
      !status.connected ||
      status.connectionId !== owner.grantId ||
      typeof status.identity?.email !== "string"
    )
      throw new InboxContractError(403, "Reconnect the selected owner Google account");
    const token = await getGoogleAccessToken(args);
    if (token.connectionId !== owner.grantId)
      throw new InboxContractError(403, "Google grant changed");
    return {
      token: token.accessToken,
      email: status.identity.email,
      scopes: status.grantedScopes,
    };
  },
  normalizeMessage(raw, email) {
    const message = normalizeGoogleGmailMessage(raw, email);
    if (!message) return null;
    const payload =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : null;
    return {
      message: { ...message },
      bodyText: payload ? normalizeManagedGmailBodyText(extractBody(payload)) : "",
    };
  },
});
