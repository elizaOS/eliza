import { db, inArray, users } from '@babylon/db';
import { logger } from '@babylon/shared';
import {
  type EmailRecipientRow,
  resolveRecipientEmail,
  resolveSendGridConfig,
  sendViaSendGrid,
} from './email-utils';

const WHITELIST_WELCOME_SUBJECT =
  "Congratulations, you're off the waitlist. You can play Babylon now.";

const WHITELIST_WELCOME_TEXT = [
  'Hey, you got in!',
  '',
  'Babylon is an AI-built world where humans and AI compete through prediction markets and perpetuals. You can create your own agent team and compete to win.',
  '',
  'Head to babylon.market, sign in, look around, then create one or two agents and tell them how they can help you win the game.',
  '',
  'Remember the best players get rewarded!',
  '',
  'Babylon team',
].join('\n');

const SEND_CONCURRENCY = 5;

function createWhitelistWelcomeHtml(): string {
  return [
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">',
    '  <p style="font-size:15px;line-height:1.6;color:#222;margin:0 0 16px;">Hey, you got in!</p>',
    '  <p style="font-size:15px;line-height:1.6;color:#222;margin:0 0 16px;">Babylon is an AI-built world where humans and AI compete through prediction markets and perpetuals. You can create your own agent team and compete to win.</p>',
    '  <p style="font-size:15px;line-height:1.6;color:#222;margin:0 0 16px;">Head to <a href="https://babylon.market" style="color:#1a73e8;">babylon.market</a>, sign in, look around, then create one or two agents and tell them how they can help you win the game.</p>',
    '  <p style="font-size:15px;line-height:1.6;color:#222;margin:0 0 16px;">Remember the best players get rewarded!</p>',
    '  <p style="font-size:15px;line-height:1.6;color:#222;margin:0;">Babylon team</p>',
    '</div>',
  ].join('');
}

async function sendWhitelistWelcomeEmail(input: {
  userId: string;
  userEmail: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const config = resolveSendGridConfig('WhitelistEmailService', {
    userId: input.userId,
  });
  if (!config) {
    return { sent: false, reason: 'provider_not_configured' };
  }

  return sendViaSendGrid(
    config.apiKey,
    {
      from: config.from,
      personalizations: [{ to: [{ email: input.userEmail }] }],
      subject: WHITELIST_WELCOME_SUBJECT,
      content: [
        { type: 'text/plain', value: WHITELIST_WELCOME_TEXT },
        { type: 'text/html', value: createWhitelistWelcomeHtml() },
      ],
    },
    'WhitelistEmailService',
    { userId: input.userId }
  );
}

async function fetchRecipients(
  userIds: string[]
): Promise<Map<string, EmailRecipientRow>> {
  if (userIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      privyId: users.privyId,
    })
    .from(users)
    .where(inArray(users.id, userIds));

  return new Map(rows.map((row) => [row.id, row]));
}

async function sendWelcomeEmailForUser(
  userId: string,
  recipient: EmailRecipientRow | undefined
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!recipient) {
    logger.warn(
      'Skipping whitelist welcome email: user not found',
      { userId },
      'WhitelistEmailService'
    );
    return 'skipped';
  }

  const resolvedEmail = await resolveRecipientEmail(
    recipient,
    'WhitelistEmailService'
  );
  if (!resolvedEmail) {
    logger.info(
      'Skipping whitelist welcome email: no verified email found for user',
      { userId },
      'WhitelistEmailService'
    );
    return 'skipped';
  }

  const result = await sendWhitelistWelcomeEmail({
    userId,
    userEmail: resolvedEmail,
  });

  if (result.sent) {
    return 'sent';
  }

  logger.warn(
    'Whitelist welcome email skipped by provider configuration or error',
    { userId, reason: result.reason ?? 'unknown' },
    'WhitelistEmailService'
  );
  return 'failed';
}

export async function sendWhitelistWelcomeEmailsToUsers(
  userIds: string[]
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) return;

  const recipients = await fetchRecipients(uniqueUserIds);

  for (let i = 0; i < uniqueUserIds.length; i += SEND_CONCURRENCY) {
    const chunk = uniqueUserIds.slice(i, i + SEND_CONCURRENCY);

    const chunkResults = await Promise.all(
      chunk.map((userId) =>
        sendWelcomeEmailForUser(userId, recipients.get(userId))
      )
    );

    const sentCount = chunkResults.filter((result) => result === 'sent').length;
    const skippedCount = chunkResults.filter(
      (result) => result === 'skipped'
    ).length;
    const failedCount = chunkResults.filter(
      (result) => result === 'failed'
    ).length;

    logger.info(
      'Processed whitelist welcome email chunk',
      {
        chunkSize: chunk.length,
        sentCount,
        skippedCount,
        failedCount,
      },
      'WhitelistEmailService'
    );
  }
}

export async function sendWhitelistWelcomeEmailToUser(
  userId: string
): Promise<void> {
  await sendWhitelistWelcomeEmailsToUsers([userId]);
}
