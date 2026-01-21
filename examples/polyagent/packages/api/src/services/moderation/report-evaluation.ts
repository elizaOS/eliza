/**
 * Report Evaluation Service
 *
 * @description Collects contextual information including chat messages, posts, and
 * historical reports, then uses AI to evaluate report validity and determine
 * appropriate moderation actions. Provides confidence scores and recommended actions
 * for each evaluation.
 */

import {
  count,
  db,
  desc,
  eq,
  messages,
  posts,
  reports,
  users,
} from "@polyagent/db";
import { logger } from "@polyagent/shared";
import { callClaudeDirect } from "../claude-service";

/**
 * NotificationService interface for dependency injection
 *
 * @description Service interface injected from the web application layer
 * to avoid circular dependencies between packages.
 */
type NotificationService = {
  createNotification: (params: {
    userId: string;
    type: string;
    title: string;
    message: string;
  }) => Promise<void>;
};

let notificationServiceInstance: NotificationService | null = null;

export function setNotificationService(service: NotificationService): void {
  notificationServiceInstance = service;
}

function getNotificationService(): NotificationService {
  if (!notificationServiceInstance) {
    throw new Error(
      "NotificationService not initialized. Call setNotificationService() first.",
    );
  }
  return notificationServiceInstance;
}

export type ReportEvaluationOutcome =
  | "valid_report" // Reporter has valid reason, reported user is abusive
  | "invalid_report" // Reporter has fair reason but is not right
  | "abusive_reporter" // Reporter is being abusive themselves
  | "insufficient_evidence"; // Not enough evidence to make a determination

export interface ReportEvaluationResult {
  outcome: ReportEvaluationOutcome;
  confidence: number; // 0-1
  reasoning: string;
  recommendedActions: string[];
  evidenceSummary: {
    chatMessages: number;
    posts: number;
    reportsReceived: number;
    reportsSent: number;
  };
}

interface ReportContext {
  reporter: {
    id: string;
    username: string | null;
    displayName: string | null;
    recentReportsSent: number;
    recentReportsReceived: number;
    earnedPoints: number;
    totalDeposited: number;
    totalWithdrawn: number;
    lifetimePnL: number;
  };
  reported: {
    id: string;
    username: string | null;
    displayName: string | null;
    recentReportsReceived: number;
    recentReportsSent: number;
    earnedPoints: number;
    totalDeposited: number;
    totalWithdrawn: number;
    lifetimePnL: number;
  };
  report: {
    id: string;
    category: string;
    reason: string;
    evidence: string | null;
    createdAt: Date;
  };
  chatMessages: Array<{
    id: string;
    senderId: string;
    content: string;
    createdAt: Date;
  }>;
  posts: Array<{
    id: string;
    content: string;
    createdAt: Date;
  }>;
}

/**
 * Evaluate a report by collecting context and using AI
 */
export async function evaluateReport(
  reportId: string,
): Promise<ReportEvaluationResult> {
  logger.info("Evaluating report", { reportId }, "ReportEvaluation");

  // Collect context
  const context = await collectReportContext(reportId);

  if (!context) {
    return {
      outcome: "insufficient_evidence",
      confidence: 0,
      reasoning: "Report or users not found",
      recommendedActions: [],
      evidenceSummary: {
        chatMessages: 0,
        posts: 0,
        reportsReceived: 0,
        reportsSent: 0,
      },
    };
  }

  // Use AI to evaluate
  const evaluation = await evaluateWithAI(context);

  logger.info(
    "Report evaluation complete",
    {
      reportId,
      outcome: evaluation.outcome,
      confidence: evaluation.confidence,
    },
    "ReportEvaluation",
  );

  // Send notification to reporter about evaluation result
  const [report] = await db
    .select({
      reporterId: reports.reporterId,
      reportedUserId: reports.reportedUserId,
    })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  if (report) {
    const notificationService = getNotificationService();
    await notificationService.createNotification({
      userId: report.reporterId,
      type: "system",
      title: "Report Evaluation Complete",
      message: `Your report has been evaluated. Outcome: ${evaluation.outcome.replace("_", " ")}. ${evaluation.reasoning.substring(0, 100)}...`,
    });
  }

  return evaluation;
}

/**
 * Collect all relevant context for a report
 */
async function collectReportContext(
  reportId: string,
): Promise<ReportContext | null> {
  const [report] = await db
    .select({
      id: reports.id,
      reporterId: reports.reporterId,
      reportedUserId: reports.reportedUserId,
      category: reports.category,
      reason: reports.reason,
      evidence: reports.evidence,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  if (!report || !report.reportedUserId) {
    return null;
  }

  // Get reporter info
  const [reporter] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      earnedPoints: users.earnedPoints,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
      lifetimePnL: users.lifetimePnL,
    })
    .from(users)
    .where(eq(users.id, report.reporterId))
    .limit(1);

  if (!reporter) {
    return null;
  }

  // Get reported user info
  const [reportedUser] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      earnedPoints: users.earnedPoints,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
      lifetimePnL: users.lifetimePnL,
    })
    .from(users)
    .where(eq(users.id, report.reportedUserId))
    .limit(1);

  const reporterId = report.reporterId;
  const reportedId = report.reportedUserId;

  // Find DM chat between reporter and reported
  const sortedIds = [reporterId, reportedId].sort();
  const chatId = `dm-${sortedIds.join("-")}`;

  const chatMessages = await db
    .select({
      id: messages.id,
      senderId: messages.senderId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  // Get recent posts from both users (last 30 days)
  const reporterPosts = await db
    .select({
      id: posts.id,
      content: posts.content,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(eq(posts.authorId, reporterId))
    .orderBy(desc(posts.createdAt))
    .limit(20);

  const reportedPosts = await db
    .select({
      id: posts.id,
      content: posts.content,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(eq(posts.authorId, reportedId))
    .orderBy(desc(posts.createdAt))
    .limit(20);

  // Get report counts
  const [reporterReportsSentResult] = await db
    .select({ count: count() })
    .from(reports)
    .where(eq(reports.reporterId, reporterId));

  const [reporterReportsReceivedResult] = await db
    .select({ count: count() })
    .from(reports)
    .where(eq(reports.reportedUserId, reporterId));

  const [reportedReportsSentResult] = await db
    .select({ count: count() })
    .from(reports)
    .where(eq(reports.reporterId, reportedId));

  const [reportedReportsReceivedResult] = await db
    .select({ count: count() })
    .from(reports)
    .where(eq(reports.reportedUserId, reportedId));

  return {
    reporter: {
      id: reporterId,
      username: reporter.username,
      displayName: reporter.displayName,
      recentReportsSent: reporterReportsSentResult?.count ?? 0,
      recentReportsReceived: reporterReportsReceivedResult?.count ?? 0,
      earnedPoints: reporter.earnedPoints,
      totalDeposited: Number(reporter.totalDeposited),
      totalWithdrawn: Number(reporter.totalWithdrawn),
      lifetimePnL: Number(reporter.lifetimePnL),
    },
    reported: {
      id: reportedId,
      username: reportedUser?.username ?? null,
      displayName: reportedUser?.displayName ?? null,
      recentReportsReceived: reportedReportsReceivedResult?.count ?? 0,
      recentReportsSent: reportedReportsSentResult?.count ?? 0,
      earnedPoints: reportedUser?.earnedPoints ?? 0,
      totalDeposited: reportedUser ? Number(reportedUser.totalDeposited) : 0,
      totalWithdrawn: reportedUser ? Number(reportedUser.totalWithdrawn) : 0,
      lifetimePnL: reportedUser ? Number(reportedUser.lifetimePnL) : 0,
    },
    report: {
      id: report.id,
      category: report.category,
      reason: report.reason,
      evidence: report.evidence,
      createdAt: report.createdAt,
    },
    chatMessages,
    posts: [...reporterPosts, ...reportedPosts].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    ),
  };
}

/**
 * Use AI to evaluate the report context
 */
async function evaluateWithAI(
  context: ReportContext,
): Promise<ReportEvaluationResult> {
  const prompt = `You are a moderation AI evaluating a user report. Analyze the context and determine if the report is valid.

IMPORTANT: This platform has a right-leaning libertarian policy around speech. We DO NOT ban for:
- Crude jokes
- Harassment (unless it involves scamming or CSAM)
- Offensive language
- Political disagreements
- Spam (unless it's scamming)

We ONLY ban for TWO things:
1. SCAMMING: Attempting to steal points or real money from other users
2. CSAM: Child Sexual Abuse Material (this is illegal and could bring FBI attention)

REPORT DETAILS:
- Category: ${context.report.category}
- Reason: ${context.report.reason}
- Evidence: ${context.report.evidence || "None provided"}

REPORTER:
- Username: ${context.reporter.username || context.reporter.displayName || context.reporter.id}
- Reports sent (last 30 days): ${context.reporter.recentReportsSent}
- Reports received (last 30 days): ${context.reporter.recentReportsReceived}
- Earned points from markets: ${context.reporter.earnedPoints}
- Total deposited (real money): $${context.reporter.totalDeposited.toFixed(2)}
- Total withdrawn (real money): $${context.reporter.totalWithdrawn.toFixed(2)}
- Lifetime P&L: $${context.reporter.lifetimePnL.toFixed(2)}

REPORTED USER:
- Username: ${context.reported.username || context.reported.displayName || context.reported.id}
- Reports received (last 30 days): ${context.reported.recentReportsReceived}
- Reports sent (last 30 days): ${context.reported.recentReportsSent}
- Earned points from markets: ${context.reported.earnedPoints}
- Total deposited (real money): $${context.reported.totalDeposited.toFixed(2)}
- Total withdrawn (real money): $${context.reported.totalWithdrawn.toFixed(2)}
- Lifetime P&L: $${context.reported.lifetimePnL.toFixed(2)}

RECENT CHAT MESSAGES (${context.chatMessages.length} messages):
${context.chatMessages
  .slice(0, 20)
  .map((msg) => {
    const sender =
      msg.senderId === context.reporter.id ? "REPORTER" : "REPORTED";
    return `[${sender}] ${msg.content.substring(0, 200)}`;
  })
  .join("\n")}

RECENT POSTS (${context.posts.length} posts):
${context.posts
  .slice(0, 10)
  .map((post) => {
    const author = post.id.startsWith(context.reporter.id)
      ? "REPORTER"
      : "REPORTED";
    return `[${author}] ${post.content.substring(0, 200)}`;
  })
  .join("\n")}

EVALUATION CRITERIA (ONLY evaluate for scamming or CSAM):
1. Is the reported user attempting to SCAM others (steal points or real money)?
   - Look for: Requests for money, fake investment schemes, phishing attempts, promises of returns that seem too good to be true
   - Consider: Their financial activity (deposits/withdrawals) and earned points patterns
2. Is there CSAM (Child Sexual Abuse Material)?
   - This is illegal and must be reported
   - Look for: Explicit content involving minors, grooming behavior
3. Is the reporter making false accusations or being abusive themselves?
4. Is there sufficient evidence to make a determination?

DO NOT flag for:
- Crude jokes
- Harassment (unless it's part of a scam)
- Offensive language
- Spam (unless it's scamming)
- Political disagreements

Respond with a JSON object:
{
  "outcome": "valid_report" | "invalid_report" | "abusive_reporter" | "insufficient_evidence",
  "confidence": 0.0-1.0,
  "reasoning": "Detailed explanation focusing ONLY on scamming or CSAM evidence",
  "recommendedActions": ["action1", "action2", ...]
}`;

  const response = await callClaudeDirect({
    prompt,
    system:
      "You are a moderation AI for a right-leaning libertarian platform. You ONLY ban for scamming (stealing points/money) or CSAM. You do NOT ban for crude jokes, harassment, or offensive language.",
    model: "claude-sonnet-4-5",
    temperature: 0.2, // Lower temperature for more consistent evaluations
    maxTokens: 4096,
  });

  const content = response.trim();

  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in AI response");
  }

  const evaluation = JSON.parse(jsonMatch[0]) as ReportEvaluationResult;

  // Validate outcome
  if (
    ![
      "valid_report",
      "invalid_report",
      "abusive_reporter",
      "insufficient_evidence",
    ].includes(evaluation.outcome)
  ) {
    evaluation.outcome = "insufficient_evidence";
  }

  // Add evidence summary
  evaluation.evidenceSummary = {
    chatMessages: context.chatMessages.length,
    posts: context.posts.length,
    reportsReceived: context.reported.recentReportsReceived,
    reportsSent: context.reporter.recentReportsSent,
  };

  return evaluation;
}

/**
 * Store evaluation result in database
 */
export async function storeEvaluationResult(
  reportId: string,
  evaluation: ReportEvaluationResult,
): Promise<void> {
  await db
    .update(reports)
    .set({
      resolution: JSON.stringify(evaluation),
      status: evaluation.outcome === "valid_report" ? "resolved" : "reviewing",
      updatedAt: new Date(),
    })
    .where(eq(reports.id, reportId));
}
