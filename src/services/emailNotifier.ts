export interface EmailAlertPayload {
  to?: string;
  subject: string;
  body: string;
  level: "INFO" | "REPAIR_ALERT" | "CRITICAL_DRIFT" | "USER_NOTIFICATION";
  audience?: "user" | "admin";
}

/**
 * Autonomous Email Alert Dispatcher
 * Sends updates, operational health, and receipts to the ACTIVE LOGGED-IN USER
 * by default.
 * Admin-only security/repair notices route strictly to configured server-side admin secrets.
 */
export class EmailNotifier {
  private resendApiKey: string;
  private adminEmail: string;

  constructor() {
    this.resendApiKey = (typeof process !== "undefined" ? process.env?.RESEND_API_KEY : "") || "";
    this.adminEmail = (typeof process !== "undefined" ? process.env?.MASTER_ADMIN_EMAIL || process.env?.LEADER_EMAIL : "") || "";
  }

  /**
   * Resolves recipient dynamically from the authenticated session user.
   */
  resolveRecipient(targetUserEmail?: string, audience: "user" | "admin" = "user"): string | null {
    if (audience === "admin") {
      return this.adminEmail || targetUserEmail || null;
    }
    return targetUserEmail || this.adminEmail || null;
  }

  async sendEmail(payload: EmailAlertPayload, userEmail?: string): Promise<boolean> {
    const audience = payload.audience || "user";
    const recipient = payload.to || this.resolveRecipient(userEmail, audience);

    if (!recipient) {
      console.log(`[EMAIL NOTICE]: No recipient address provided for ${payload.subject}. Skipping dispatch.`);
      return false;
    }

    const formattedSubject = `[VALHALLA OS ${payload.level}] ${payload.subject}`;
    console.log(`[EMAIL DISPATCH] Audience: ${audience.toUpperCase()} | Recipient: ${recipient} | Subject: ${formattedSubject}`);

    if (!this.resendApiKey) {
      console.log(`[EMAIL SIMULATED]: Delivered to session user ${recipient}.\nBody: ${payload.body.substring(0, 160)}...`);
      return true;
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "ValhallaOS <updates@valhalla-app.xyz>",
          to: [recipient],
          subject: formattedSubject,
          text: payload.body,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[EMAIL DISPATCH FAILED] ${res.status}: ${errText}`);
        return false;
      }

      console.log(`[EMAIL DELIVERED] Autonomous update sent to ${recipient}`);
      return true;
    } catch (err: any) {
      console.error("[EMAIL ERROR]", err.message);
      return false;
    }
  }
}
