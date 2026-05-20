import { createNotification, sendNotificationEmail } from '@babylon/api';
import {
  and,
  db,
  eq,
  gt,
  gte,
  isNotNull,
  lt,
  markets,
  or,
  positions,
  users,
} from '@babylon/db';
import {
  isValidDeliveryChannel,
  isValidDigestFrequency,
  logger,
  type NotificationDeliveryChannel,
  type NotificationDigestFrequency,
  type NotificationDigestSettings,
  type PerformanceDigestNotificationData,
} from '@babylon/shared';
import { groupResolvedMarketOutcomes } from './market-resolution-notifications';

interface DigestCandidateUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  digestEnabled: boolean;
  digestFrequency: NotificationDigestFrequency;
  deliveryChannel: NotificationDeliveryChannel;
  lastSentAt: Date | null;
}

interface DigestComputationResult {
  title: string;
  message: string;
  data: PerformanceDigestNotificationData;
  dedupeKey: string;
}

const DIGEST_WINDOWS_MS: Record<NotificationDigestFrequency, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

interface ValidatedDigestRow {
  id: string;
  email: string | null;
  emailVerified: boolean;
  digestEnabled: boolean;
  digestFrequency: NotificationDigestFrequency;
  deliveryChannel: NotificationDeliveryChannel;
  lastSentAt: Date | null;
}

function isValidDigestCandidateRow(row: {
  id: string;
  email: string | null;
  emailVerified: boolean;
  digestEnabled: boolean;
  digestFrequency: string | null;
  deliveryChannel: string | null;
  lastSentAt: Date | null;
}): row is ValidatedDigestRow {
  if (!isValidDigestFrequency(row.digestFrequency)) {
    logger.warn(
      'Invalid digest frequency in database',
      { userId: row.id, value: row.digestFrequency },
      'NotificationDigestService'
    );
    return false;
  }
  if (!isValidDeliveryChannel(row.deliveryChannel)) {
    logger.warn(
      'Invalid delivery channel in database',
      { userId: row.id, value: row.deliveryChannel },
      'NotificationDigestService'
    );
    return false;
  }
  return true;
}

export function getDigestWindowStart(
  now: Date,
  frequency: NotificationDigestFrequency
): Date {
  return new Date(now.getTime() - DIGEST_WINDOWS_MS[frequency]);
}

export function isDigestDue(params: {
  now: Date;
  frequency: NotificationDigestFrequency;
  lastSentAt: Date | null;
}): boolean {
  if (!params.lastSentAt) {
    return true;
  }

  return (
    params.now.getTime() - params.lastSentAt.getTime() >=
    DIGEST_WINDOWS_MS[params.frequency]
  );
}

function formatSignedPoints(points: number): string {
  const sign = points >= 0 ? '+' : '-';
  return `${sign}${Math.abs(points).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })}`;
}

export async function listDigestCandidates(): Promise<DigestCandidateUser[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      digestEnabled: users.notificationDigestEnabled,
      digestFrequency: users.notificationDigestFrequency,
      deliveryChannel: users.notificationDigestDeliveryChannel,
      lastSentAt: users.notificationDigestLastSentAt,
    })
    .from(users)
    .where(eq(users.notificationDigestEnabled, true));

  return rows.filter(isValidDigestCandidateRow);
}

export async function buildDigestForUser(params: {
  userId: string;
  frequency: NotificationDigestFrequency;
  now: Date;
}): Promise<DigestComputationResult | null> {
  const windowStart = getDigestWindowStart(params.now, params.frequency);

  const rows = await db
    .select({
      holderId: positions.userId,
      managedBy: users.managedBy,
      isAgent: users.isAgent,
      agentName: users.displayName,
      marketId: positions.marketId,
      marketName: markets.question,
      pnl: positions.pnl,
    })
    .from(positions)
    .innerJoin(markets, eq(markets.id, positions.marketId))
    .leftJoin(users, eq(users.id, positions.userId))
    .where(
      and(
        eq(positions.status, 'resolved'),
        isNotNull(positions.outcome),
        isNotNull(positions.pnl),
        isNotNull(positions.resolvedAt),
        gt(positions.shares, '0'),
        gte(positions.resolvedAt, windowStart),
        lt(positions.resolvedAt, params.now),
        or(
          eq(positions.userId, params.userId),
          eq(users.managedBy, params.userId)
        )
      )
    );

  const groupedOutcomes = groupResolvedMarketOutcomes(
    rows.map((row) => ({
      holderId: row.holderId,
      ownerUserId: row.isAgent && row.managedBy ? row.managedBy : row.holderId,
      marketId: row.marketId,
      marketName: row.marketName,
      points: Number(row.pnl),
      agentName: row.isAgent ? row.agentName : null,
    }))
  ).filter((entry) => entry.ownerUserId === params.userId);

  if (groupedOutcomes.length === 0) {
    return null;
  }

  const netPointsChange = Number(
    groupedOutcomes.reduce((sum, entry) => sum + entry.points, 0).toFixed(2)
  );
  const marketsWon = groupedOutcomes.filter((entry) => entry.points > 0).length;
  const marketsLost = groupedOutcomes.filter(
    (entry) => entry.points < 0
  ).length;

  const topAgent = groupedOutcomes
    .filter((entry) => entry.agentName)
    .reduce<Map<string, number>>((acc, entry) => {
      const agentName = entry.agentName!;
      acc.set(agentName, Number((acc.get(agentName) ?? 0) + entry.points));
      return acc;
    }, new Map());

  const topPerformingAgent = Array.from(topAgent.entries()).sort(
    (left, right) => right[1] - left[1]
  )[0];

  const summary = [
    `${formatSignedPoints(netPointsChange)} points net`,
    `${marketsWon} won`,
    `${marketsLost} lost`,
    topPerformingAgent
      ? `top agent ${topPerformingAgent[0]} (${formatSignedPoints(topPerformingAgent[1])})`
      : 'no agent activity',
  ].join(' | ');

  const title =
    params.frequency === 'hourly'
      ? 'Hourly performance digest'
      : params.frequency === 'weekly'
        ? 'Weekly performance digest'
        : 'Daily performance digest';

  const message = `Your ${params.frequency} digest: ${summary}.`;
  const data: PerformanceDigestNotificationData = {
    frequency: params.frequency,
    periodStart: windowStart.toISOString(),
    periodEnd: params.now.toISOString(),
    netPointsChange,
    marketsWon,
    marketsLost,
    topPerformingAgent: topPerformingAgent
      ? {
          name: topPerformingAgent[0],
          points: Number(topPerformingAgent[1].toFixed(2)),
        }
      : null,
    summary,
  };

  return {
    title,
    message,
    data,
    dedupeKey: `digest:${params.frequency}:${params.userId}:${windowStart.toISOString()}`,
  };
}

export async function deliverDigestForUser(params: {
  candidate: DigestCandidateUser;
  settings: NotificationDigestSettings;
  now: Date;
}): Promise<{ delivered: boolean; hadContent: boolean }> {
  const digest = await buildDigestForUser({
    userId: params.candidate.id,
    frequency: params.settings.frequency,
    now: params.now,
  });

  if (!digest) {
    await db
      .update(users)
      .set({
        notificationDigestLastSentAt: params.now,
        updatedAt: params.now,
      })
      .where(eq(users.id, params.candidate.id));

    return { delivered: false, hadContent: false };
  }

  let delivered = false;

  if (
    params.settings.deliveryChannel === 'in-app' ||
    params.settings.deliveryChannel === 'both'
  ) {
    const notificationType =
      params.settings.frequency === 'hourly'
        ? 'hourly_summary'
        : params.settings.frequency === 'weekly'
          ? 'weekly_summary'
          : 'daily_summary';

    const result = await createNotification({
      userId: params.candidate.id,
      type: notificationType,
      title: digest.title,
      message: digest.message,
      data: digest.data,
      dedupeKey: digest.dedupeKey,
      sendEmail: false,
    });

    delivered = delivered || result.created;
  }

  if (
    (params.settings.deliveryChannel === 'email' ||
      params.settings.deliveryChannel === 'both') &&
    params.candidate.email &&
    params.candidate.emailVerified
  ) {
    await sendNotificationEmail({
      userId: params.candidate.id,
      userEmail: params.candidate.email,
      title: digest.title,
      message: digest.message,
      category:
        params.settings.frequency === 'hourly'
          ? 'hourly_summary'
          : params.settings.frequency === 'weekly'
            ? 'weekly_summary'
            : 'daily_summary',
    });

    delivered = true;
  }

  if (!delivered) {
    logger.info(
      'Digest skipped because no active delivery channel was available',
      {
        userId: params.candidate.id,
        deliveryChannel: params.settings.deliveryChannel,
      },
      'NotificationDigestService'
    );
    return { delivered: false, hadContent: true };
  }

  await db
    .update(users)
    .set({
      notificationDigestLastSentAt: params.now,
      updatedAt: params.now,
    })
    .where(eq(users.id, params.candidate.id));

  return { delivered: true, hadContent: true };
}
