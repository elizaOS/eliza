/**
 * POST /api/feedback
 * Sends user feedback to the developer email.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { emailService } from "@/lib/services/email";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

const feedbackSchema = z.object({
  name: z.string().max(100).optional().default(""),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
  comment: z.string().min(1, "Comment is required").max(5000),
});

async function handlePOST(request: NextRequest) {
  const body = await request.json();
  const validated = feedbackSchema.parse(body);

  const { name, email, comment } = validated;
  const timestamp = new Date().toISOString();
  const displayName = name || "Anonymous";
  const displayEmail = email || "Not provided";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>New Feedback from Eliza Cloud</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #0a0a0a; color: #ffffff;">
  <div style="background: linear-gradient(135deg, rgba(255, 88, 0, 0.1) 0%, rgba(0, 0, 0, 0.8) 100%); padding: 30px; border-radius: 12px; border: 1px solid rgba(255, 88, 0, 0.2);">
    <h2 style="color: #FF5800; margin-top: 0; font-size: 24px;">New Feedback Received</h2>
    
    <div style="background: rgba(255, 255, 255, 0.05); padding: 20px; border-radius: 8px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 10px 0; color: #888; width: 100px;"><strong>From:</strong></td>
          <td style="padding: 10px 0; color: #fff;">${escapeHtml(displayName)}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #888;"><strong>Email:</strong></td>
          <td style="padding: 10px 0; color: #fff;">${email ? `<a href="mailto:${escapeHtml(email)}" style="color: #FF5800;">${escapeHtml(email)}</a>` : `<span style="color: #666;">${displayEmail}</span>`}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #888;"><strong>Time:</strong></td>
          <td style="padding: 10px 0; color: #fff;">${timestamp}</td>
        </tr>
      </table>
    </div>

    <div style="background: rgba(255, 255, 255, 0.05); padding: 20px; border-radius: 8px; margin: 20px 0;">
      <h3 style="color: #FF5800; margin-top: 0; font-size: 16px;">Message:</h3>
      <p style="color: #fff; line-height: 1.6; white-space: pre-wrap; margin: 0;">${escapeHtml(comment)}</p>
    </div>

    <hr style="border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 30px 0;">
    
    <p style="color: #666; font-size: 12px; text-align: center; margin-bottom: 0;">
      This feedback was submitted via Eliza Cloud
    </p>
  </div>
</body>
</html>`;

  const text = `
New Feedback from Eliza Cloud
==============================

From: ${displayName}
Email: ${displayEmail}
Time: ${timestamp}

Message:
${comment}

---
This feedback was submitted via Eliza Cloud
`;

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
    return NextResponse.json(
      {
        success: false,
        error:
          "Email service is not configured. Please contact support directly at developer@eliza.ai",
      },
      { status: 503 },
    );
  }

  logger.info("[Feedback] Feedback email sent successfully", {
    name: displayName,
    email: displayEmail,
  });

  return NextResponse.json({
    success: true,
    message: "Feedback sent successfully",
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STRICT);
