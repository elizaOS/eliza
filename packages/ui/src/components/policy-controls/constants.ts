import type {
  ApprovedAddressesConfig,
  AutoApproveConfig,
  RateLimitConfig,
  SpendingLimitConfig,
  TimeWindowConfig,
} from "./types";

/** All monetary values are in USD for cross-chain compatibility. */
export const DEFAULT_SPENDING: SpendingLimitConfig = {
  maxPerTx: "50",
  maxPerDay: "500",
  maxPerWeek: "2000",
};

export const DEFAULT_APPROVED_ADDRESSES: ApprovedAddressesConfig = {
  addresses: [],
  labels: {},
  mode: "whitelist",
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxTxPerHour: 10,
  maxTxPerDay: 50,
};

export const DEFAULT_TIME_WINDOW: TimeWindowConfig = {
  allowedHours: [{ start: 9, end: 17 }],
  allowedDays: [1, 2, 3, 4, 5],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

/** Threshold in USD. */
export const DEFAULT_AUTO_APPROVE: AutoApproveConfig = {
  threshold: "5",
};

export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
];

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
