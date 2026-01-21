"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AdminMatchesPage,
  AdminMatchSummary,
  AdminSafetyPage,
  AdminUsersPage,
  AnalyticsSnapshot,
  AnalyticsSummary,
  ApiResponse,
  SafetyReportSummary,
  UserRecord,
} from "@/types/api";
import styles from "./page.module.css";

type AdminTab = "overview" | "users" | "matches" | "safety" | "exports";

type MatchEdit = {
  status?: string;
  meetingStatus?: string;
  scheduledAt?: string;
  locationName?: string;
  locationAddress?: string;
  locationCity?: string;
};

type UserFilters = {
  q: string;
  status: string;
  isAdmin: string;
};

type MatchFilters = {
  q: string;
  status: string;
  domain: string;
};

type SafetyFilters = {
  q: string;
  status: string;
  severity: string;
};

const MATCH_STATUSES = [
  "proposed",
  "accepted",
  "scheduled",
  "completed",
  "canceled",
  "expired",
];

const MEETING_STATUSES = ["scheduled", "completed", "no_show", "canceled"];

const padTime = (value: number): string =>
  value < 10 ? `0${value}` : String(value);

const toLocalInput = (iso?: string): string => {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${[
    date.getFullYear(),
    padTime(date.getMonth() + 1),
    padTime(date.getDate()),
  ].join("-")}T${padTime(date.getHours())}:${padTime(date.getMinutes())}`;
};

const encodeCursor = (
  cursor: { createdAt: string; id: string } | null,
): string | null => (cursor ? `${cursor.createdAt}|${cursor.id}` : null);

const buildQuery = (
  entries: Array<[string, string | undefined | null]>,
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

const formatPercent = (value: number) => `${(value * 100).toFixed(0)}%`;

export default function AdminClient() {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsTrends, setAnalyticsTrends] = useState<AnalyticsSnapshot[]>(
    [],
  );
  const [trendsLoading, setTrendsLoading] = useState(false);

  const [usersPage, setUsersPage] = useState<AdminUsersPage | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userFilters, setUserFilters] = useState<UserFilters>({
    q: "",
    status: "",
    isAdmin: "",
  });
  const [appliedUserFilters, setAppliedUserFilters] = useState<UserFilters>({
    q: "",
    status: "",
    isAdmin: "",
  });
  const [userCursor, setUserCursor] = useState<string | null>(null);
  const [userCursorStack, setUserCursorStack] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    new Set(),
  );
  const [bulkCreditDelta, setBulkCreditDelta] = useState("");
  const [drawerCreditDelta, setDrawerCreditDelta] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);

  const [matchesPage, setMatchesPage] = useState<AdminMatchesPage | null>(null);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchFilters, setMatchFilters] = useState<MatchFilters>({
    q: "",
    status: "",
    domain: "",
  });
  const [appliedMatchFilters, setAppliedMatchFilters] = useState<MatchFilters>({
    q: "",
    status: "",
    domain: "",
  });
  const [matchCursor, setMatchCursor] = useState<string | null>(null);
  const [matchCursorStack, setMatchCursorStack] = useState<string[]>([]);
  const [matchEdits, setMatchEdits] = useState<Record<string, MatchEdit>>({});
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);

  const [safetyPage, setSafetyPage] = useState<AdminSafetyPage | null>(null);
  const [safetyLoading, setSafetyLoading] = useState(false);
  const [safetyFilters, setSafetyFilters] = useState<SafetyFilters>({
    q: "",
    status: "",
    severity: "",
  });
  const [appliedSafetyFilters, setAppliedSafetyFilters] =
    useState<SafetyFilters>({
      q: "",
      status: "",
      severity: "",
    });
  const [safetyCursor, setSafetyCursor] = useState<string | null>(null);
  const [safetyCursorStack, setSafetyCursorStack] = useState<string[]>([]);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/analytics");
      const payload = (await response.json()) as ApiResponse<AnalyticsSummary>;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setAnalytics(payload.data);
    } catch {
      setError("Unable to load analytics.");
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  const loadTrends = useCallback(async () => {
    setTrendsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/analytics/trends?days=14");
      const payload = (await response.json()) as ApiResponse<
        AnalyticsSnapshot[]
      >;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setAnalyticsTrends(payload.data);
    } catch {
      setError("Unable to load analytics trends.");
    } finally {
      setTrendsLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setError(null);
    try {
      const query = buildQuery([
        ["q", appliedUserFilters.q.trim()],
        ["status", appliedUserFilters.status],
        ["isAdmin", appliedUserFilters.isAdmin],
        ["limit", "50"],
        ["cursor", userCursor],
      ]);
      const response = await fetch(`/api/admin/users${query}`);
      const payload = (await response.json()) as ApiResponse<AdminUsersPage>;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setUsersPage(payload.data);
    } catch {
      setError("Unable to load users.");
    } finally {
      setUsersLoading(false);
    }
  }, [appliedUserFilters, userCursor]);

  const loadMatches = useCallback(async () => {
    setMatchesLoading(true);
    setError(null);
    try {
      const query = buildQuery([
        ["q", appliedMatchFilters.q.trim()],
        ["status", appliedMatchFilters.status],
        ["domain", appliedMatchFilters.domain],
        ["limit", "25"],
        ["cursor", matchCursor],
      ]);
      const response = await fetch(`/api/admin/matches${query}`);
      const payload = (await response.json()) as ApiResponse<AdminMatchesPage>;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setMatchesPage(payload.data);
    } catch {
      setError("Unable to load matches.");
    } finally {
      setMatchesLoading(false);
    }
  }, [appliedMatchFilters, matchCursor]);

  const loadSafety = useCallback(async () => {
    setSafetyLoading(true);
    setError(null);
    try {
      const query = buildQuery([
        ["q", appliedSafetyFilters.q.trim()],
        ["status", appliedSafetyFilters.status],
        ["severity", appliedSafetyFilters.severity],
        ["limit", "25"],
        ["cursor", safetyCursor],
      ]);
      const response = await fetch(`/api/admin/safety${query}`);
      const payload = (await response.json()) as ApiResponse<AdminSafetyPage>;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setSafetyPage(payload.data);
    } catch {
      setError("Unable to load safety reports.");
    } finally {
      setSafetyLoading(false);
    }
  }, [appliedSafetyFilters, safetyCursor]);

  useEffect(() => {
    loadAnalytics();
    loadTrends();
  }, [loadAnalytics, loadTrends]);

  useEffect(() => {
    if (activeTab === "users") {
      loadUsers();
    }
    if (activeTab === "matches") {
      loadMatches();
    }
    if (activeTab === "safety") {
      loadSafety();
    }
  }, [activeTab, loadMatches, loadSafety, loadUsers]);

  const updateMatchEdit = useCallback(
    (matchId: string, patch: Partial<MatchEdit>) => {
      setMatchEdits((prev) => ({
        ...prev,
        [matchId]: {
          ...prev[matchId],
          ...patch,
        },
      }));
    },
    [],
  );

  const handleCreditAdjust = useCallback(
    async (userId: string, delta: number, reload = true) => {
      if (!Number.isFinite(delta) || delta === 0) {
        setError("Enter a non-zero credit delta.");
        return;
      }
      setNotice(null);
      setError(null);
      try {
        const response = await fetch("/api/admin/credits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, delta }),
        });
        const payload = (await response.json()) as ApiResponse<UserRecord>;
        if (!payload.ok) {
          setError(payload.error);
          return;
        }
        if (reload) {
          setNotice("Credits updated.");
        }
        if (reload) {
          await loadUsers();
        }
      } catch {
        setError("Unable to update credits.");
      }
    },
    [loadUsers],
  );

  const updateUser = useCallback(
    async (
      userId: string,
      updates: { status?: "active" | "blocked"; isAdmin?: boolean },
      reload = true,
    ) => {
      setNotice(null);
      setError(null);
      try {
        const response = await fetch("/api/admin/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, ...updates }),
        });
        const payload = (await response.json()) as ApiResponse<UserRecord>;
        if (!payload.ok) {
          setError(payload.error);
          return;
        }
        if (reload) {
          setNotice("User updated.");
        }
        if (selectedUser?.id === userId) {
          setSelectedUser(payload.data);
        }
        if (reload) {
          await loadUsers();
        }
      } catch {
        setError("Unable to update user.");
      }
    },
    [loadUsers, selectedUser],
  );

  const applyBulkStatus = useCallback(
    async (status: "active" | "blocked") => {
      setNotice(null);
      setError(null);
      try {
        for (const userId of selectedUserIds) {
          await updateUser(userId, { status }, false);
        }
        setNotice("Selected users updated.");
        await loadUsers();
      } catch {
        setError("Unable to update selected users.");
      }
    },
    [loadUsers, selectedUserIds, updateUser],
  );

  const applyBulkAdmin = useCallback(
    async (isAdmin: boolean) => {
      setNotice(null);
      setError(null);
      try {
        for (const userId of selectedUserIds) {
          await updateUser(userId, { isAdmin }, false);
        }
        setNotice("Selected users updated.");
        await loadUsers();
      } catch {
        setError("Unable to update selected users.");
      }
    },
    [loadUsers, selectedUserIds, updateUser],
  );

  const applyBulkCredits = useCallback(async () => {
    const parsed = Number.parseInt(bulkCreditDelta, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError("Enter a non-zero credit delta.");
      return;
    }
    setNotice(null);
    setError(null);
    try {
      for (const userId of selectedUserIds) {
        await handleCreditAdjust(userId, parsed, false);
      }
      setNotice("Credits updated for selected users.");
      setBulkCreditDelta("");
      await loadUsers();
    } catch {
      setError("Unable to update credits for selected users.");
    }
  }, [bulkCreditDelta, handleCreditAdjust, loadUsers, selectedUserIds]);

  const handleMatchUpdate = useCallback(
    async (match: AdminMatchSummary) => {
      const edit = matchEdits[match.matchId];
      if (!edit) {
        setError("No changes to update.");
        return;
      }
      const payload: {
        matchId: string;
        status?: string;
        meetingStatus?: string;
        scheduledAt?: string;
        location?: { name: string; address: string; city: string };
      } = { matchId: match.matchId };

      if (edit.status && edit.status !== match.status) {
        payload.status = edit.status;
      }
      if (edit.meetingStatus) {
        payload.meetingStatus = edit.meetingStatus;
      }
      if (edit.scheduledAt) {
        const date = new Date(edit.scheduledAt);
        if (!Number.isFinite(date.getTime())) {
          setError("Invalid meeting time.");
          return;
        }
        payload.scheduledAt = date.toISOString();
      }
      if (edit.locationName || edit.locationAddress || edit.locationCity) {
        payload.location = {
          name: edit.locationName ?? match.meeting?.location.name ?? "TBD",
          address:
            edit.locationAddress ?? match.meeting?.location.address ?? "TBD",
          city: edit.locationCity ?? match.meeting?.location.city ?? "TBD",
        };
      }

      if (
        !payload.status &&
        !payload.meetingStatus &&
        !payload.scheduledAt &&
        !payload.location
      ) {
        setError("No changes to update.");
        return;
      }

      setNotice(null);
      setError(null);
      try {
        const response = await fetch("/api/admin/matches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result =
          (await response.json()) as ApiResponse<AdminMatchSummary>;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNotice("Match updated.");
        setMatchEdits((prev) => {
          const next = { ...prev };
          delete next[match.matchId];
          return next;
        });
        await loadMatches();
      } catch {
        setError("Unable to update match.");
      }
    },
    [loadMatches, matchEdits],
  );

  const updateSafetyStatus = useCallback(
    async (reportId: string, status: "open" | "reviewing" | "resolved") => {
      setNotice(null);
      setError(null);
      try {
        const response = await fetch("/api/admin/safety", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportId, status }),
        });
        const payload =
          (await response.json()) as ApiResponse<SafetyReportSummary>;
        if (!payload.ok) {
          setError(payload.error);
          return;
        }
        await loadSafety();
      } catch {
        setError("Unable to update safety report.");
      }
    },
    [loadSafety],
  );

  const downloadExport = useCallback((dataset: string, format: string) => {
    const url = `/api/admin/export?dataset=${dataset}&format=${format}`;
    window.open(url, "_blank");
  }, []);

  const users = usersPage?.items ?? [];
  const matches = matchesPage?.items ?? [];
  const safetyReports = safetyPage?.items ?? [];
  const allUsersSelected =
    users.length > 0 && users.every((user) => selectedUserIds.has(user.id));
  const selectedUserCount = selectedUserIds.size;

  const handleUsersNext = useCallback(() => {
    const next = encodeCursor(usersPage?.nextCursor ?? null);
    if (!next) return;
    setUserCursorStack((prev) => [...prev, userCursor ?? ""]);
    setUserCursor(next);
    setSelectedUserIds(new Set());
  }, [userCursor, usersPage?.nextCursor]);

  const handleUsersPrev = useCallback(() => {
    setUserCursorStack((prev) => {
      const next = [...prev];
      const previous = next.pop() ?? "";
      setUserCursor(previous || null);
      setSelectedUserIds(new Set());
      return next;
    });
  }, []);

  const handleMatchesNext = useCallback(() => {
    const next = encodeCursor(matchesPage?.nextCursor ?? null);
    if (!next) return;
    setMatchCursorStack((prev) => [...prev, matchCursor ?? ""]);
    setMatchCursor(next);
  }, [matchCursor, matchesPage?.nextCursor]);

  const handleMatchesPrev = useCallback(() => {
    setMatchCursorStack((prev) => {
      const next = [...prev];
      const previous = next.pop() ?? "";
      setMatchCursor(previous || null);
      return next;
    });
  }, []);

  const handleSafetyNext = useCallback(() => {
    const next = encodeCursor(safetyPage?.nextCursor ?? null);
    if (!next) return;
    setSafetyCursorStack((prev) => [...prev, safetyCursor ?? ""]);
    setSafetyCursor(next);
  }, [safetyCursor, safetyPage?.nextCursor]);

  const handleSafetyPrev = useCallback(() => {
    setSafetyCursorStack((prev) => {
      const next = [...prev];
      const previous = next.pop() ?? "";
      setSafetyCursor(previous || null);
      return next;
    });
  }, []);

  const applyUserFilters = useCallback(() => {
    setAppliedUserFilters({ ...userFilters });
    setUserCursor(null);
    setUserCursorStack([]);
    setSelectedUserIds(new Set());
  }, [userFilters]);

  const applyMatchFilters = useCallback(() => {
    setAppliedMatchFilters({ ...matchFilters });
    setMatchCursor(null);
    setMatchCursorStack([]);
    setExpandedMatchId(null);
  }, [matchFilters]);

  const applySafetyFilters = useCallback(() => {
    setAppliedSafetyFilters({ ...safetyFilters });
    setSafetyCursor(null);
    setSafetyCursorStack([]);
  }, [safetyFilters]);

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTitle}>Admin</div>
        <button
          type="button"
          className={
            activeTab === "overview" ? styles.navActive : styles.navButton
          }
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={
            activeTab === "users" ? styles.navActive : styles.navButton
          }
          onClick={() => setActiveTab("users")}
        >
          Users
        </button>
        <button
          type="button"
          className={
            activeTab === "matches" ? styles.navActive : styles.navButton
          }
          onClick={() => setActiveTab("matches")}
        >
          Matches
        </button>
        <button
          type="button"
          className={
            activeTab === "safety" ? styles.navActive : styles.navButton
          }
          onClick={() => setActiveTab("safety")}
        >
          Safety
        </button>
        <button
          type="button"
          className={
            activeTab === "exports" ? styles.navActive : styles.navButton
          }
          onClick={() => setActiveTab("exports")}
        >
          Exports
        </button>
      </aside>

      <div className={selectedUser ? styles.content : styles.contentFull}>
        <header className={styles.header}>
          <div>
            <h1>Admin</h1>
            <p>Manage members, matches, safety, and operations.</p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              onClick={() => {
                loadAnalytics();
                loadTrends();
              }}
              className={styles.buttonSecondary}
            >
              Refresh
            </button>
          </div>
        </header>

        {notice ? <p className={styles.notice}>{notice}</p> : null}
        {error ? <p className={styles.error}>{error}</p> : null}

        {activeTab === "overview" ? (
          <section className={styles.card}>
            <h2>Analytics</h2>
            {analyticsLoading ? (
              <p className={styles.notice}>Loading analytics…</p>
            ) : analytics ? (
              <div className={styles.analyticsGrid}>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>Active members</span>
                  <span className={styles.metricValue}>
                    {analytics.users.active}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>Meeting completion</span>
                  <span className={styles.metricValue}>
                    {formatPercent(analytics.meetings.completionRate)}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>
                    Repeat meeting rate
                  </span>
                  <span className={styles.metricValue}>
                    {formatPercent(analytics.repeatMeetingRate)}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>Positive feedback</span>
                  <span className={styles.metricValue}>
                    {formatPercent(analytics.feedback.positiveRate)}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>Day 7 retention</span>
                  <span className={styles.metricValue}>
                    {formatPercent(analytics.retention.day7)}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>Day 30 retention</span>
                  <span className={styles.metricValue}>
                    {formatPercent(analytics.retention.day30)}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>
                    Safety reports open
                  </span>
                  <span className={styles.metricValue}>
                    {analytics.safety.open}
                  </span>
                </div>
                <div className={styles.metric}>
                  <span className={styles.metricLabel}>Avg reliability</span>
                  <span className={styles.metricValue}>
                    {analytics.reliability.averageScore.toFixed(2)}
                  </span>
                </div>
              </div>
            ) : (
              <p className={styles.muted}>Analytics not available yet.</p>
            )}

            <div className={styles.trendSection}>
              <h3>Recent trends (14 days)</h3>
              {trendsLoading ? (
                <p className={styles.notice}>Loading trend snapshots…</p>
              ) : analyticsTrends.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th>Active users</th>
                        <th>Meeting completion</th>
                        <th>Safety open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analyticsTrends.map((snapshot) => (
                        <tr key={snapshot.day}>
                          <td>{snapshot.day}</td>
                          <td>{snapshot.summary.users.active}</td>
                          <td>
                            {formatPercent(
                              snapshot.summary.meetings.completionRate,
                            )}
                          </td>
                          <td>{snapshot.summary.safety.open}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.muted}>No trend snapshots yet.</p>
              )}
            </div>
          </section>
        ) : null}

        {activeTab === "users" ? (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2>Users</h2>
              <div className={styles.filterRow}>
                <input
                  type="text"
                  placeholder="Search name, phone, email"
                  value={userFilters.q}
                  onChange={(event) =>
                    setUserFilters((prev) => ({
                      ...prev,
                      q: event.target.value,
                    }))
                  }
                />
                <select
                  value={userFilters.status}
                  onChange={(event) =>
                    setUserFilters((prev) => ({
                      ...prev,
                      status: event.target.value,
                    }))
                  }
                >
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="blocked">Blocked</option>
                </select>
                <select
                  value={userFilters.isAdmin}
                  onChange={(event) =>
                    setUserFilters((prev) => ({
                      ...prev,
                      isAdmin: event.target.value,
                    }))
                  }
                >
                  <option value="">All roles</option>
                  <option value="true">Admins</option>
                  <option value="false">Members</option>
                </select>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={applyUserFilters}
                >
                  Apply
                </button>
              </div>
              {selectedUserCount > 0 ? (
                <div className={styles.bulkRow}>
                  <span>{selectedUserCount} selected</span>
                  <button
                    type="button"
                    onClick={() => applyBulkStatus("blocked")}
                    className={styles.buttonSecondary}
                  >
                    Block
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBulkStatus("active")}
                    className={styles.buttonSecondary}
                  >
                    Unblock
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBulkAdmin(true)}
                    className={styles.buttonSecondary}
                  >
                    Make admin
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBulkAdmin(false)}
                    className={styles.buttonSecondary}
                  >
                    Remove admin
                  </button>
                  <input
                    type="number"
                    placeholder="Credit delta"
                    value={bulkCreditDelta}
                    onChange={(event) => setBulkCreditDelta(event.target.value)}
                  />
                  <button
                    type="button"
                    onClick={applyBulkCredits}
                    className={styles.buttonSecondary}
                  >
                    Apply credits
                  </button>
                </div>
              ) : null}
            </div>

            {usersLoading ? (
              <p className={styles.notice}>Loading users…</p>
            ) : null}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={allUsersSelected}
                        onChange={() => {
                          if (!usersPage) return;
                          setSelectedUserIds((prev) => {
                            const next = new Set(prev);
                            if (allUsersSelected) {
                              usersPage.items.forEach((user) => {
                                next.delete(user.id);
                              });
                            } else {
                              usersPage.items.forEach((user) => {
                                next.add(user.id);
                              });
                            }
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th>User</th>
                    <th>Status</th>
                    <th>Credits</th>
                    <th>Admin</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedUserIds.has(user.id)}
                          onChange={() => {
                            setSelectedUserIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(user.id)) {
                                next.delete(user.id);
                              } else {
                                next.add(user.id);
                              }
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td>
                        <div className={styles.userCell}>
                          <span className={styles.userName}>
                            {user.name ?? user.phone}
                          </span>
                          <span className={styles.muted}>{user.phone}</span>
                        </div>
                      </td>
                      <td>{user.status}</td>
                      <td>{user.credits}</td>
                      <td>{user.isAdmin ? "Yes" : "No"}</td>
                      <td>{new Date(user.createdAt).toLocaleDateString()}</td>
                      <td className={styles.actionCell}>
                        <button
                          type="button"
                          className={styles.buttonSecondary}
                          onClick={() => setSelectedUser(user)}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className={styles.buttonSecondary}
                          onClick={() =>
                            updateUser(user.id, {
                              status:
                                user.status === "blocked"
                                  ? "active"
                                  : "blocked",
                            })
                          }
                        >
                          {user.status === "blocked" ? "Unblock" : "Block"}
                        </button>
                        <button
                          type="button"
                          className={styles.buttonSecondary}
                          onClick={() =>
                            updateUser(user.id, { isAdmin: !user.isAdmin })
                          }
                        >
                          {user.isAdmin ? "Revoke admin" : "Make admin"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={7} className={styles.muted}>
                        No users found.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className={styles.paginationRow}>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleUsersPrev}
                disabled={userCursorStack.length === 0}
              >
                Previous
              </button>
              <span className={styles.muted}>
                Total {usersPage?.total ?? 0}
              </span>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleUsersNext}
                disabled={!usersPage?.nextCursor}
              >
                Next
              </button>
            </div>
          </section>
        ) : null}

        {activeTab === "matches" ? (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2>Matches</h2>
              <div className={styles.filterRow}>
                <input
                  type="text"
                  placeholder="Search match, names, phones"
                  value={matchFilters.q}
                  onChange={(event) =>
                    setMatchFilters((prev) => ({
                      ...prev,
                      q: event.target.value,
                    }))
                  }
                />
                <select
                  value={matchFilters.status}
                  onChange={(event) =>
                    setMatchFilters((prev) => ({
                      ...prev,
                      status: event.target.value,
                    }))
                  }
                >
                  <option value="">All statuses</option>
                  {MATCH_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Domain"
                  value={matchFilters.domain}
                  onChange={(event) =>
                    setMatchFilters((prev) => ({
                      ...prev,
                      domain: event.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={applyMatchFilters}
                >
                  Apply
                </button>
              </div>
            </div>

            {matchesLoading ? (
              <p className={styles.notice}>Loading matches…</p>
            ) : null}
            <div className={styles.matchList}>
              {matches.map((match) => {
                const edit = matchEdits[match.matchId] ?? {};
                const meeting = match.meeting;
                const isExpanded = expandedMatchId === match.matchId;
                return (
                  <div key={match.matchId} className={styles.matchRow}>
                    <div className={styles.matchHeader}>
                      <div>
                        <span className={styles.badge}>{match.status}</span>{" "}
                        <span className={styles.badge}>{match.domain}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.buttonSecondary}
                        onClick={() =>
                          setExpandedMatchId(isExpanded ? null : match.matchId)
                        }
                      >
                        {isExpanded ? "Hide" : "Edit"}
                      </button>
                    </div>
                    <div>
                      {match.personaA.name} ↔ {match.personaB.name}
                    </div>
                    <div className={styles.muted}>
                      Score {match.score.toFixed(1)} · Created{" "}
                      {new Date(match.createdAt).toLocaleDateString()}
                    </div>
                    {meeting ? (
                      <div className={styles.muted}>
                        Meeting {meeting.status} ·{" "}
                        {new Date(meeting.scheduledAt).toLocaleString()}
                      </div>
                    ) : (
                      <div className={styles.muted}>
                        No meeting scheduled yet.
                      </div>
                    )}
                    {isExpanded ? (
                      <div className={styles.matchActions}>
                        <label className={styles.matchField}>
                          Match status
                          <select
                            value={edit.status ?? match.status}
                            onChange={(event) =>
                              updateMatchEdit(match.matchId, {
                                status: event.target.value,
                              })
                            }
                          >
                            {MATCH_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {status}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className={styles.matchField}>
                          Meeting status
                          <select
                            value={
                              edit.meetingStatus ??
                              meeting?.status ??
                              "scheduled"
                            }
                            onChange={(event) =>
                              updateMatchEdit(match.matchId, {
                                meetingStatus: event.target.value,
                              })
                            }
                          >
                            {MEETING_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {status}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className={styles.matchField}>
                          Schedule
                          <input
                            type="datetime-local"
                            value={
                              edit.scheduledAt ??
                              toLocalInput(meeting?.scheduledAt)
                            }
                            onChange={(event) =>
                              updateMatchEdit(match.matchId, {
                                scheduledAt: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className={styles.matchField}>
                          Location name
                          <input
                            type="text"
                            value={
                              edit.locationName ?? meeting?.location.name ?? ""
                            }
                            onChange={(event) =>
                              updateMatchEdit(match.matchId, {
                                locationName: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className={styles.matchField}>
                          Location address
                          <input
                            type="text"
                            value={
                              edit.locationAddress ??
                              meeting?.location.address ??
                              ""
                            }
                            onChange={(event) =>
                              updateMatchEdit(match.matchId, {
                                locationAddress: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className={styles.matchField}>
                          Location city
                          <input
                            type="text"
                            value={
                              edit.locationCity ?? meeting?.location.city ?? ""
                            }
                            onChange={(event) =>
                              updateMatchEdit(match.matchId, {
                                locationCity: event.target.value,
                              })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className={styles.primaryButton}
                          onClick={() => handleMatchUpdate(match)}
                        >
                          Update match
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {matches.length === 0 ? (
                <p className={styles.muted}>No matches found.</p>
              ) : null}
            </div>
            <div className={styles.paginationRow}>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleMatchesPrev}
                disabled={matchCursorStack.length === 0}
              >
                Previous
              </button>
              <span className={styles.muted}>
                Total {matchesPage?.total ?? 0}
              </span>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleMatchesNext}
                disabled={!matchesPage?.nextCursor}
              >
                Next
              </button>
            </div>
          </section>
        ) : null}

        {activeTab === "safety" ? (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2>Safety Reports</h2>
              <div className={styles.filterRow}>
                <input
                  type="text"
                  placeholder="Search notes, names, phones"
                  value={safetyFilters.q}
                  onChange={(event) =>
                    setSafetyFilters((prev) => ({
                      ...prev,
                      q: event.target.value,
                    }))
                  }
                />
                <select
                  value={safetyFilters.status}
                  onChange={(event) =>
                    setSafetyFilters((prev) => ({
                      ...prev,
                      status: event.target.value,
                    }))
                  }
                >
                  <option value="">All statuses</option>
                  <option value="open">Open</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="resolved">Resolved</option>
                </select>
                <select
                  value={safetyFilters.severity}
                  onChange={(event) =>
                    setSafetyFilters((prev) => ({
                      ...prev,
                      severity: event.target.value,
                    }))
                  }
                >
                  <option value="">All severities</option>
                  <option value="level1">Level 1</option>
                  <option value="level2">Level 2</option>
                  <option value="level3">Level 3</option>
                </select>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={applySafetyFilters}
                >
                  Apply
                </button>
              </div>
            </div>

            {safetyLoading ? (
              <p className={styles.notice}>Loading safety reports…</p>
            ) : null}
            <div className={styles.matchList}>
              {safetyReports.map((report) => (
                <div key={report.reportId} className={styles.safetyRow}>
                  <div className={styles.safetyHeader}>
                    <div>
                      <span className={styles.badge}>{report.severity}</span>{" "}
                      <span className={styles.badge}>{report.status}</span>
                    </div>
                    <div className={styles.safetyActions}>
                      <button
                        type="button"
                        className={styles.buttonSecondary}
                        onClick={() =>
                          updateSafetyStatus(report.reportId, "reviewing")
                        }
                      >
                        Mark reviewing
                      </button>
                      <button
                        type="button"
                        className={styles.buttonSecondary}
                        onClick={() =>
                          updateSafetyStatus(report.reportId, "resolved")
                        }
                      >
                        Resolve
                      </button>
                    </div>
                  </div>
                  <div className={styles.muted}>
                    {report.reporter.name} → {report.target.name}
                  </div>
                  <div>{report.notes}</div>
                  {report.transcriptRef ? (
                    <div className={styles.muted}>
                      Transcript: {report.transcriptRef}
                    </div>
                  ) : null}
                </div>
              ))}
              {safetyReports.length === 0 ? (
                <p className={styles.muted}>No safety reports found.</p>
              ) : null}
            </div>
            <div className={styles.paginationRow}>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleSafetyPrev}
                disabled={safetyCursorStack.length === 0}
              >
                Previous
              </button>
              <span className={styles.muted}>
                Total {safetyPage?.total ?? 0}
              </span>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleSafetyNext}
                disabled={!safetyPage?.nextCursor}
              >
                Next
              </button>
            </div>
          </section>
        ) : null}

        {activeTab === "exports" ? (
          <section className={styles.card}>
            <h2>Exports</h2>
            <div className={styles.exportRow}>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("all", "json")}
              >
                Download JSON
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("analytics", "csv")}
              >
                Analytics CSV
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("users", "csv")}
              >
                Users CSV
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("matches", "csv")}
              >
                Matches CSV
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("meetings", "csv")}
              >
                Meetings CSV
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("safety", "csv")}
              >
                Safety CSV
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => downloadExport("all", "csv")}
              >
                All CSV
              </button>
            </div>
          </section>
        ) : null}
      </div>

      {selectedUser ? (
        <aside className={styles.drawer}>
          <div className={styles.drawerHeader}>
            <h3>User Details</h3>
            <button
              type="button"
              className={styles.buttonSecondary}
              onClick={() => setSelectedUser(null)}
            >
              Close
            </button>
          </div>
          <div className={styles.drawerBody}>
            <div className={styles.drawerRow}>
              <span>Name</span>
              <span>{selectedUser.name ?? "Unknown"}</span>
            </div>
            <div className={styles.drawerRow}>
              <span>Phone</span>
              <span>{selectedUser.phone}</span>
            </div>
            <div className={styles.drawerRow}>
              <span>Status</span>
              <span>{selectedUser.status}</span>
            </div>
            <div className={styles.drawerRow}>
              <span>Credits</span>
              <span>{selectedUser.credits}</span>
            </div>
            <div className={styles.drawerRow}>
              <span>Admin</span>
              <span>{selectedUser.isAdmin ? "Yes" : "No"}</span>
            </div>
            <div className={styles.drawerRow}>
              <span>Created</span>
              <span>{new Date(selectedUser.createdAt).toLocaleString()}</span>
            </div>
            <div className={styles.drawerRow}>
              <span>Updated</span>
              <span>{new Date(selectedUser.updatedAt).toLocaleString()}</span>
            </div>
          </div>
          <div className={styles.drawerActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() =>
                updateUser(selectedUser.id, {
                  status:
                    selectedUser.status === "blocked" ? "active" : "blocked",
                })
              }
            >
              {selectedUser.status === "blocked"
                ? "Unblock user"
                : "Block user"}
            </button>
            <button
              type="button"
              className={styles.buttonSecondary}
              onClick={() =>
                updateUser(selectedUser.id, { isAdmin: !selectedUser.isAdmin })
              }
            >
              {selectedUser.isAdmin ? "Revoke admin" : "Make admin"}
            </button>
            <div className={styles.drawerCredit}>
              <input
                type="number"
                placeholder="Credit delta"
                value={drawerCreditDelta}
                onChange={(event) => setDrawerCreditDelta(event.target.value)}
              />
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => {
                  const parsed = Number.parseInt(drawerCreditDelta, 10);
                  if (Number.isFinite(parsed)) {
                    handleCreditAdjust(selectedUser.id, parsed);
                    setDrawerCreditDelta("");
                  }
                }}
              >
                Apply credits
              </button>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
