/**
 * POST /api/feedback
 * Sends user feedback to the developer email.
 */

import { Hono } from "hono";
import { z } from "zod";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { emailService } from "@/lib/services/email";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const feedbackSchema = z.object({
  name: z.string().max(100).optional().default(""),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
  comment: z.string().min(1, "Comment is required").max(5000),
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  const body = await c.req.json();
  const { name, email, comment } = feedbackSchema.parse(body);
  const timestamp = new Date().toISOString();
  const displayName = name || "Anonymous";
  const displayEmail = email || "Not provided";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>New Feedback from Eliza Cloud</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #0a0a0a; color: #ffffff;">
  <h2 style="color: #FF5800;">New Feedback Received</h2>
  <p><strong>From:</strong> ${escapeHtml(displayName)}</p>
  <p><strong>Email:</strong> ${escapeHtml(displayEmail)}</p>
  <p><strong>Time:</strong> ${timestamp}</p>
  <p><strong>Message:</strong></p>
  <pre style="white-space: pre-wrap;">${escapeHtml(comment)}</pre>
</body>
</html>`;
  const text = `New Feedback\n\nFrom: ${displayName}\nEmail: ${displayEmail}\nTime: ${timestamp}\n\nMessage:\n${comment}`;

  const sent = await emailService.send({
    to: "developer@elizalabs.ai",
    subject: `[Eliza Cloud Feedback] from ${displayName}`,
    html,
    text,
    ...(email && { replyTo: email }),
  });

  if (!sent) {
    logger.error("[Feedback] Failed to send feedback email", {
      name: displayName,
      email: displayEmail,
    });
    return c.json(
      {
        success: false,
        error:
          "Email service is not configured. Please contact support directly at developer@eliza.ai",
      },
      503,
    );
  }

  logger.info("[Feedback] Feedback email sent successfully", {
    name: displayName,
    email: displayEmail,
  });
  return c.json({ success: true, message: "Feedback sent successfully" });
});

export default app;
