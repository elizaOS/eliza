import type { EngineState, PersonaId } from "@engine/types";
import type { AnalyticsSummary } from "@/lib/analytics-types";
import type { UserRecord } from "@/lib/store";

export type { AnalyticsSummary } from "@/lib/analytics-types";

const dayMs = 24 * 60 * 60 * 1000;

const initMatchCounts = (): AnalyticsSummary["matches"] => ({
  total: 0,
  proposed: 0,
  accepted: 0,
  scheduled: 0,
  completed: 0,
  canceled: 0,
  expired: 0,
});

const initMeetingCounts = (): AnalyticsSummary["meetings"] => ({
  total: 0,
  scheduled: 0,
  completed: 0,
  canceled: 0,
  no_show: 0,
  completionRate: 0,
  reschedules: 0,
});

export const computeAnalytics = (
  users: UserRecord[],
  state: EngineState,
): AnalyticsSummary => {
  const userCounts = {
    total: users.length,
    active: users.filter((user) => user.status === "active").length,
    pending: users.filter((user) => user.status === "pending").length,
    blocked: users.filter((user) => user.status === "blocked").length,
  };

  const matchCounts = initMatchCounts();
  for (const match of state.matches) {
    matchCounts.total += 1;
    matchCounts[match.status] += 1;
  }

  const meetingCounts = initMeetingCounts();
  for (const meeting of state.meetings) {
    meetingCounts.total += 1;
    meetingCounts[meeting.status] += 1;
    meetingCounts.reschedules += meeting.rescheduleCount ?? 0;
  }

  const completionDenominator =
    meetingCounts.scheduled +
    meetingCounts.completed +
    meetingCounts.canceled +
    meetingCounts.no_show;
  meetingCounts.completionRate =
    completionDenominator > 0
      ? meetingCounts.completed / completionDenominator
      : 0;

  const feedbackTotals = {
    total: 0,
    positive: 0,
    neutral: 0,
    negative: 0,
    positiveRate: 0,
  };
  for (const entry of state.feedbackQueue) {
    feedbackTotals.total += 1;
    if (entry.sentiment === "positive") feedbackTotals.positive += 1;
    if (entry.sentiment === "neutral") feedbackTotals.neutral += 1;
    if (entry.sentiment === "negative") feedbackTotals.negative += 1;
  }
  feedbackTotals.positiveRate =
    feedbackTotals.total > 0
      ? feedbackTotals.positive / feedbackTotals.total
      : 0;

  const reliabilityScores = state.personas.map(
    (persona) => persona.reliability.score,
  );
  const averageScore =
    reliabilityScores.length > 0
      ? reliabilityScores.reduce((sum, score) => sum + score, 0) /
        reliabilityScores.length
      : 0;
  const reliability = {
    averageScore,
    lowCount: reliabilityScores.filter((score) => score < 0.5).length,
    highCount: reliabilityScores.filter((score) => score >= 0.8).length,
  };

  const meetingCountsByPersona = new Map<PersonaId, number>();
  for (const meeting of state.meetings) {
    const match = state.matches.find(
      (entry) => entry.matchId === meeting.matchId,
    );
    if (!match) continue;
    const increment = (personaId: PersonaId) => {
      meetingCountsByPersona.set(
        personaId,
        (meetingCountsByPersona.get(personaId) ?? 0) + 1,
      );
    };
    increment(match.personaA);
    increment(match.personaB);
  }
  const participants = Array.from(meetingCountsByPersona.values());
  const repeaters = participants.filter((count) => count >= 2).length;
  const repeatMeetingRate =
    participants.length > 0 ? repeaters / participants.length : 0;

  const now = Date.now();
  const eligible7 = users.filter(
    (user) => now - Date.parse(user.createdAt) >= 7 * dayMs,
  );
  const eligible30 = users.filter(
    (user) => now - Date.parse(user.createdAt) >= 30 * dayMs,
  );
  const retained7 = eligible7.filter(
    (user) =>
      Date.parse(user.updatedAt) - Date.parse(user.createdAt) >= 7 * dayMs,
  );
  const retained30 = eligible30.filter(
    (user) =>
      Date.parse(user.updatedAt) - Date.parse(user.createdAt) >= 30 * dayMs,
  );

  const cancellations = {
    total: meetingCounts.canceled,
    late: state.meetings.filter(
      (meeting) =>
        meeting.status === "canceled" &&
        (meeting.cancellationReason ?? "").includes("late"),
    ).length,
  };

  const safetyCounts = {
    total: state.safetyReports.length,
    open: state.safetyReports.filter((report) => report.status === "open")
      .length,
    reviewing: state.safetyReports.filter(
      (report) => report.status === "reviewing",
    ).length,
    resolved: state.safetyReports.filter(
      (report) => report.status === "resolved",
    ).length,
    level1: state.safetyReports.filter((report) => report.severity === "level1")
      .length,
    level2: state.safetyReports.filter((report) => report.severity === "level2")
      .length,
    level3: state.safetyReports.filter((report) => report.severity === "level3")
      .length,
  };

  return {
    users: userCounts,
    matches: matchCounts,
    meetings: meetingCounts,
    feedback: feedbackTotals,
    reliability,
    retention: {
      day7: eligible7.length > 0 ? retained7.length / eligible7.length : 0,
      day30: eligible30.length > 0 ? retained30.length / eligible30.length : 0,
      eligible7: eligible7.length,
      eligible30: eligible30.length,
    },
    repeatMeetingRate,
    cancellations,
    safety: safetyCounts,
  };
};
