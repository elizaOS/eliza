import { createHmac, timingSafeEqual } from 'node:crypto';
import { escapeHtml } from '../utils/html';
import { resolveSendGridConfig, sendViaSendGrid } from './email-utils';

export type EmailNotificationCategory =
  | 'realtime'
  | 'hourly_summary'
  | 'daily_summary'
  | 'weekly_summary'
  | 'monthly_summary';

interface UnsubscribeTokenPayload {
  userId: string;
  email: string;
  exp: number;
}

export interface SendNotificationEmailInput {
  userId: string;
  userEmail: string;
  title: string;
  message: string;
  category: EmailNotificationCategory;
}

const DEFAULT_UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function getBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, '');
  }

  return 'http://localhost:3000';
}

function getUnsubscribeSecret(): string | null {
  return (
    process.env.NOTIFICATION_EMAIL_UNSUBSCRIBE_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    null
  );
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function createNotificationUnsubscribeToken(params: {
  userId: string;
  email: string;
  ttlSeconds?: number;
}): string | null {
  const secret = getUnsubscribeSecret();
  if (!secret) return null;

  const nowInSeconds = Math.floor(Date.now() / 1000);
  const payload: UnsubscribeTokenPayload = {
    userId: params.userId,
    email: params.email.toLowerCase(),
    exp:
      nowInSeconds +
      (params.ttlSeconds ?? DEFAULT_UNSUBSCRIBE_TOKEN_TTL_SECONDS),
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url'
  );
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyNotificationUnsubscribeToken(
  token: string
): UnsubscribeTokenPayload | null {
  const secret = getUnsubscribeSecret();
  if (!secret) return null;

  const [encodedPayload, providedSignature] = token.split('.');
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload, secret);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded) as UnsubscribeTokenPayload;

    if (
      !payload ||
      typeof payload.userId !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowInSeconds) {
      return null;
    }

    return {
      userId: payload.userId,
      email: payload.email.toLowerCase(),
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export function buildNotificationUnsubscribeUrl(params: {
  userId: string;
  email: string;
}): string | null {
  const token = createNotificationUnsubscribeToken(params);
  if (!token) return null;

  const baseUrl = getBaseUrl();
  return `${baseUrl}/api/notifications/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

function getCategoryLabel(category: EmailNotificationCategory): string {
  switch (category) {
    case 'hourly_summary':
      return 'Hourly Summary';
    case 'daily_summary':
      return 'Daily Summary';
    case 'weekly_summary':
      return 'Weekly Summary';
    case 'monthly_summary':
      return 'Monthly Summary';
    default:
      return 'Real-Time Notification';
  }
}

function createEmailHtml(params: {
  title: string;
  message: string;
  category: EmailNotificationCategory;
  unsubscribeUrl: string | null;
}): string {
  const unsubscribeSection = params.unsubscribeUrl
    ? `<p style="margin-top:24px;color:#666;font-size:12px;line-height:1.5;">
         You can unsubscribe from all notification emails at any time:
         <a href="${params.unsubscribeUrl}">Unsubscribe</a>
       </p>`
    : '';

  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <h1 style="font-size:20px;margin:0 0 8px;">${escapeHtml(params.title)}</h1>
      <p style="margin:0 0 16px;color:#555;font-size:13px;">
        ${getCategoryLabel(params.category)}
      </p>
      <p style="font-size:15px;line-height:1.6;color:#222;margin:0;">
        ${escapeHtml(params.message)}
      </p>
      ${unsubscribeSection}
    </div>
  `;
}

function createEmailText(params: {
  title: string;
  message: string;
  category: EmailNotificationCategory;
  unsubscribeUrl: string | null;
}): string {
  const unsubscribeSection = params.unsubscribeUrl
    ? `\n\nUnsubscribe: ${params.unsubscribeUrl}`
    : '';

  return `${params.title}\n\nType: ${getCategoryLabel(params.category)}\n\n${params.message}${unsubscribeSection}`;
}

export async function sendNotificationEmail(
  input: SendNotificationEmailInput
): Promise<{ sent: boolean; reason?: string }> {
  const logContext = { userId: input.userId, category: input.category };
  const config = resolveSendGridConfig('NotificationEmailService', logContext);
  if (!config) {
    return { sent: false, reason: 'provider_not_configured' };
  }

  const unsubscribeUrl = buildNotificationUnsubscribeUrl({
    userId: input.userId,
    email: input.userEmail,
  });

  const subject = `[Babylon] ${input.title}`;
  const html = createEmailHtml({
    title: input.title,
    message: input.message,
    category: input.category,
    unsubscribeUrl,
  });
  const text = createEmailText({
    title: input.title,
    message: input.message,
    category: input.category,
    unsubscribeUrl,
  });

  return sendViaSendGrid(
    config.apiKey,
    {
      from: config.from,
      personalizations: [{ to: [{ email: input.userEmail }] }],
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
      headers: unsubscribeUrl
        ? {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined,
    },
    'NotificationEmailService',
    logContext
  );
}
