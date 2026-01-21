export type AnalyticsSummary = {
  users: {
    total: number;
    active: number;
    pending: number;
    blocked: number;
  };
  matches: {
    total: number;
    proposed: number;
    accepted: number;
    scheduled: number;
    completed: number;
    canceled: number;
    expired: number;
  };
  meetings: {
    total: number;
    scheduled: number;
    completed: number;
    canceled: number;
    no_show: number;
    completionRate: number;
    reschedules: number;
  };
  feedback: {
    total: number;
    positive: number;
    neutral: number;
    negative: number;
    positiveRate: number;
  };
  reliability: {
    averageScore: number;
    lowCount: number;
    highCount: number;
  };
  retention: {
    day7: number;
    day30: number;
    eligible7: number;
    eligible30: number;
  };
  repeatMeetingRate: number;
  cancellations: {
    total: number;
    late: number;
  };
  safety: {
    total: number;
    open: number;
    reviewing: number;
    resolved: number;
    level1: number;
    level2: number;
    level3: number;
  };
};
