import {
  verifyNotificationUnsubscribeToken,
  withErrorHandling,
} from '@feed/api';
import { and, db, eq, users } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

function htmlResponse(content: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Feed Email Preferences</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
      .container { max-width: 560px; margin: 48px auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
      h1 { margin: 0 0 12px; font-size: 20px; }
      p { margin: 0; line-height: 1.6; color: #334155; }
    </style>
  </head>
  <body>
    <main class="container">
      ${content}
    </main>
  </body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    }
  );
}

/**
 * Shared unsubscribe logic used by both GET (browser click) and POST (RFC 8058 one-click).
 */
async function processUnsubscribe(
  token: string,
  source: string
): Promise<Response> {
  const payload = verifyNotificationUnsubscribeToken(token);
  if (!payload) {
    return htmlResponse(
      '<h1>Invalid link</h1><p>This unsubscribe link is invalid or expired.</p>',
      400
    );
  }

  const [updatedUser] = await db
    .update(users)
    .set({
      emailNotificationsEnabled: false,
      emailNotificationsRealtime: false,
      emailNotificationsDailySummary: false,
      emailNotificationsWeeklySummary: false,
      emailNotificationsMonthlySummary: false,
      emailNotificationsUnsubscribedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.id, payload.userId),
        eq(users.email, payload.email.toLowerCase())
      )
    )
    .returning({ id: users.id });

  if (!updatedUser) {
    return htmlResponse(
      '<h1>Unable to unsubscribe</h1><p>This link does not match an active user email.</p>',
      404
    );
  }

  logger.info(
    'User unsubscribed from notification emails via signed link',
    { userId: updatedUser.id, source },
    `${source} /api/notifications/email/unsubscribe`
  );

  return htmlResponse(
    '<h1>You are unsubscribed</h1><p>You will no longer receive notification emails from Feed.</p>'
  );
}

/**
 * GET handler — browser link click from email.
 */
export const GET = withErrorHandling(async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return htmlResponse(
        '<h1>Invalid request</h1><p>Missing unsubscribe token.</p>',
        400
      );
    }

    return await processUnsubscribe(token, 'GET');
  } catch (error) {
    logger.error(
      'Email unsubscribe endpoint failed',
      { error },
      'GET /api/notifications/email/unsubscribe'
    );
    return htmlResponse(
      '<h1>Unexpected error</h1><p>We could not process your unsubscribe request. Please try again.</p>',
      500
    );
  }
});

/**
 * POST handler — RFC 8058 one-click unsubscribe (used by Gmail, Apple Mail, etc.).
 * Email clients POST with body `List-Unsubscribe=One-Click` to the List-Unsubscribe URL.
 */
export const POST = withErrorHandling(async function POST(
  request: NextRequest
): Promise<Response> {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return new Response('Missing token', { status: 400 });
    }

    return await processUnsubscribe(token, 'POST');
  } catch (error) {
    logger.error(
      'Email unsubscribe endpoint failed (one-click POST)',
      { error },
      'POST /api/notifications/email/unsubscribe'
    );
    return new Response('Internal server error', { status: 500 });
  }
});
