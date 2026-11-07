export interface EmailAlertPayload {
  to?: string;
  subject: string;
  body: string;
  level: "INFO" | "REPAIR_ALERT" | "CRITICAL_DRIFT";
}

/**
 * Autonomous Email Alert Dispatcher
 * Sends operational health reports, drift alerts, and automated repair summaries
 * to MASTER_ADMIN_EMAIL / LEADER_EMAIL without blocking main event loops.
 */
export class EmailNotifier {
  private resendApiKey: string;
  private defaultRecipient: string;

  constructor() {
    this.resendApiKey = (typeof process !== "undefined" ? process.env?.RESEND_API_KEY : "") || "";
    this.defaultRecipient = (typeof process !== "undefined" ? process.env?.MASTER_ADMIN_EMAIL || process.env?.LEADER_EMAIL : "") || "keene.jos@gmail.com";
  }

  async sendEmail(payload: EmailAlertPayload): Promise<boolean> {
    const recipient = payload.to || this.defaultRecipient;
    const formattedSubject = `[VALHALLA OS ${payload.level}] ${payload.subject}`;

    console.log(`[AUTONOMOUS EMAIL DISPATCH] Recipient: ${recipient} | Subject: ${formattedSubject}`);

    if (!this.resendApiKey) {
      console.log(`[EMAIL SIMULATED]: Notification queued locally (Set RESEND_API_KEY for live delivery).\nBody: ${payload.body.substring(0, 180)}...`);
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
          from: "ValhallaOS Overseer <overseer@valhalla-app.xyz>",
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

      console.log(`[EMAIL DELIVERED] Successfully sent autonomous update to ${recipient}`);
      return true;
    } catch (err: any) {
      console.error("[EMAIL ERROR]", err.message);
      return false;
    }
  }
}
