import type { AnalyticsSummary } from "@/lib/analytics-types";
import type {
  AllowlistEntry,
  CreditLedgerEntry,
  UserRecord,
  UserStatus,
} from "@/lib/store";

export type {
  UserStatus,
  UserRecord,
  AllowlistEntry,
  CreditLedgerEntry,
  AnalyticsSummary,
};

export type ProfileData = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  location: string | null;
  credits: number;
  status: "active" | "pending" | "blocked";
  isAdmin: boolean;
  allowlisted: boolean;
};

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiError = { ok: false; error: string };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  nextCursor: { createdAt: string; id: string } | null;
};

export type AnalyticsSnapshot = {
  day: string;
  summary: AnalyticsSummary;
  createdAt: string;
};

export type AdminMatchSummary = {
  matchId: string;
  domain: string;
  status: string;
  score: number;
  createdAt: string;
  personaA: { personaId: number; name: string; phone: string | null };
  personaB: { personaId: number; name: string; phone: string | null };
  meeting: {
    meetingId: string;
    matchId: string;
    scheduledAt: string;
    location: { name: string; address: string; city: string };
    status: string;
    rescheduleCount: number;
    cancellationReason?: string;
  } | null;
};

export type AdminUsersPage = PaginatedResult<UserRecord>;
export type AdminMatchesPage = PaginatedResult<AdminMatchSummary>;
export type AdminSafetyPage = PaginatedResult<SafetyReportSummary>;

export type SafetyReportSummary = {
  reportId: string;
  severity: string;
  status: string;
  createdAt: string;
  reporter: { personaId: number; name: string; phone: string | null };
  target: { personaId: number; name: string; phone: string | null };
  notes: string;
  transcriptRef?: string;
};
