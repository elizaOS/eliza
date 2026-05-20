export interface AchievementUnlockedNotificationData {
  [key: string]: string | number;
  kind: 'achievement_unlocked';
  achievementId: string;
  achievementName: string;
  tier: string;
  pointsReward: number;
  iconKey: string;
}

export interface ChallengeCompletedNotificationData {
  [key: string]: string | number;
  kind: 'challenge_completed';
  challengeId: string;
  challengeName: string;
  pointsReward: number;
  periodKey: string;
  iconKey: string;
}

interface RewardNotificationContent<TData> {
  title: string;
  message: string;
  data: TData;
}

function toTitleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function buildAchievementUnlockedNotification(params: {
  achievementId: string;
  achievementName: string;
  tier: string;
  pointsReward: number;
  iconKey: string;
}): RewardNotificationContent<AchievementUnlockedNotificationData> {
  return {
    title: `Achievement Unlocked: ${params.achievementName}`,
    message: `${toTitleCase(params.tier)} tier - +${params.pointsReward} points`,
    data: {
      kind: 'achievement_unlocked',
      achievementId: params.achievementId,
      achievementName: params.achievementName,
      tier: params.tier,
      pointsReward: params.pointsReward,
      iconKey: params.iconKey,
    },
  };
}

export function buildChallengeCompletedNotification(params: {
  challengeId: string;
  challengeName: string;
  pointsReward: number;
  periodKey: string;
  iconKey: string;
}): RewardNotificationContent<ChallengeCompletedNotificationData> {
  return {
    title: `Challenge Complete: ${params.challengeName}`,
    message: `+${params.pointsReward} points`,
    data: {
      kind: 'challenge_completed',
      challengeId: params.challengeId,
      challengeName: params.challengeName,
      pointsReward: params.pointsReward,
      periodKey: params.periodKey,
      iconKey: params.iconKey,
    },
  };
}
