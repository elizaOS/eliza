export class EmailNotifier {
  constructor(options = {}) {
    const env = options.env ?? globalThis.process?.env ?? {};
    this.apiKey = env.RESEND_API_KEY || "";
    this.adminEmail = env.MASTER_ADMIN_EMAIL || env.LEADER_EMAIL || "";
    this.from = env.NOTIFICATION_FROM || "";
    this.resolveUser = options.resolveUser;
    this.authorizeAdmin = options.authorizeAdmin;
    this.fetcher = options.fetchImpl ?? globalThis.fetch;
  }
  resolveRecipient(email, audience = "user") {
    const candidate = audience === "admin" ? this.adminEmail : audience === "user" ? email : null;
    return typeof candidate === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
  }
  async sendEmail(payload, context) {
    try {
      if (!context || typeof context !== "object" || !context.userId || !context.tenantId) return false;
      if (typeof this.resolveUser !== "function") return false;
      const user = await this.resolveUser(context);
      if (!user || user.id !== context.userId || user.tenantId !== context.tenantId || user.emailVerified !== true || user.notificationsEnabled !== true) return false;
      const audience = payload.audience ?? "user";
      if (audience === "admin" && (typeof this.authorizeAdmin !== "function" || await this.authorizeAdmin(context) !== true)) return false;
      const recipient = this.resolveRecipient(user.email, audience);
      if (!recipient || (payload.to && payload.to !== recipient)) return false;
      if (!this.apiKey || /your_|placeholder/i.test(this.apiKey) || !this.from) return false;
      if (typeof payload.subject !== "string" || !payload.subject.trim() || payload.subject.length > 200 || /[\r\n]/.test(payload.subject)) return false;
      if (typeof payload.body !== "string" || !payload.body.trim() || payload.body.length > 20000) return false;
      const response = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [recipient], subject: `[VALHALLA OS] ${payload.subject}`, text: payload.body }),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return false;
      const result = await response.json();
      return typeof result?.id === "string" && result.id.length > 0;
    } catch {
      return false;
    }
  }
}
