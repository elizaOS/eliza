/**
 * Upcoming Events Widget API
 *
 * @route GET /api/feed/widgets/upcoming-events - Get upcoming events
 * @access Public (optional authentication for RLS)
 *
 * @description
 * Returns upcoming events for feed widget. Includes game events, questions,
 * and related prediction markets. Supports filtering by timeframe.
 *
 * @openapi
 * /api/feed/widgets/upcoming-events:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get upcoming events
 *     description: Returns upcoming events for feed widget (optional auth for RLS)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum events to return
 *       - in: query
 *         name: timeframe
 *         schema:
 *           type: string
 *           default: 7d
 *         description: Timeframe filter (e.g., 7d, 30d)
 *     responses:
 *       200:
 *         description: Events retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *       401:
 *         description: Unauthorized (optional)
 *
 * @example
 * ```typescript
 * const { events } = await fetch('/api/feed/widgets/upcoming-events?limit=10')
 *   .then(r => r.json());
 * ```
 */

import { optionalAuth, successResponse, withErrorHandling } from "@feed/api";
import { asPublic, asUser } from "@feed/db";
import {
  FEED_WIDGET_CONFIG,
  logger,
  UpcomingEventsQuerySchema,
} from "@feed/shared";
import type { NextRequest } from "next/server";

interface UpcomingEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  isLive?: boolean;
  hint?: string; // Subtle hint about related prediction market
  // NOTE: fullDescription removed for security - could leak prediction market question text
  // which would give unfair advantage to users who can see unresolved question details
  source?: string;
  relatedQuestion?: number;
  imageUrl?: string; // Actor profile image or organization logo
  relatedActorId?: string;
  relatedOrganizationId?: string;
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Validate query parameters
  const { searchParams } = new URL(request.url);
  const queryParams = {
    limit: searchParams.get("limit") || "10",
    timeframe: searchParams.get("timeframe") || "7d",
  };
  UpcomingEventsQuerySchema.parse(queryParams);

  // Optional auth - upcoming events are public but RLS still applies
  const authUser = await optionalAuth(request).catch(() => null);

  // Get upcoming events with RLS
  const events: UpcomingEvent[] = authUser?.userId
    ? await asUser(authUser, async (db) => {
        const eventsList: UpcomingEvent[] = [];

        // 1. Get active questions that will resolve soon (within configured days)
        const activeQuestions = await db.question.findMany({
          where: {
            status: "active",
            resolutionDate: {
              gte: new Date(), // Only future resolutions
              lte: new Date(
                Date.now() +
                  FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS * 24 * 60 * 60 * 1000,
              ),
            },
          },
          orderBy: {
            resolutionDate: "asc",
          },
          take: 10,
        });

        // Transform questions into upcoming events (hinting but not revealing)
        for (const question of activeQuestions) {
          const resolutionDate = new Date(question.resolutionDate);
          const now = new Date();
          const daysUntil = Math.ceil(
            (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );

          if (
            daysUntil > FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS ||
            daysUntil < 0
          )
            continue;

          // Check if it's happening soon (within configured hours = "LIVE")
          const hoursUntil =
            (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60);
          const isLive =
            hoursUntil <= FEED_WIDGET_CONFIG.LIVE_EVENT_HOURS &&
            hoursUntil >= 0;

          // Generate event title based on question content
          let title = "Market Resolution";
          const questionText = question.text.toLowerCase();

          if (
            questionText.includes("earnings") ||
            questionText.includes("financial")
          ) {
            title = "Earnings Report";
          } else if (
            questionText.includes("meeting") ||
            questionText.includes("fed") ||
            questionText.includes("conference")
          ) {
            title = "Fed Meeting";
          } else if (
            questionText.includes("summit") ||
            questionText.includes("conference")
          ) {
            title = "AI Summit 2025";
          } else if (
            questionText.includes("launch") ||
            questionText.includes("release")
          ) {
            title = "Product Launch";
          } else if (
            questionText.includes("announcement") ||
            questionText.includes("announces")
          ) {
            title = "Major Announcement";
          } else if (
            questionText.includes("trial") ||
            questionText.includes("court")
          ) {
            title = "Court Ruling";
          } else if (
            questionText.includes("election") ||
            questionText.includes("vote")
          ) {
            title = "Election Results";
          }

          // Format date and time
          const eventDate = resolutionDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          const eventTime = resolutionDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });

          // Only show hint if very soon (within configured days) - subtle tease without revealing
          let hint: string | undefined;
          if (
            daysUntil <= FEED_WIDGET_CONFIG.HINT_SHOW_DAYS &&
            question.text.length > 0
          ) {
            // Extract key words/phrases without revealing the full question
            const words = question.text.split(" ").filter((w) => w.length > 4);
            if (words.length > 0) {
              const keyPhrase = words.slice(0, 3).join(" ");
              hint =
                keyPhrase.length > 40
                  ? `${keyPhrase.substring(0, 37)}...`
                  : keyPhrase;
            }
          }

          eventsList.push({
            id: question.id,
            title,
            date: eventDate,
            time: eventTime,
            isLive,
            hint:
              hint ||
              (daysUntil <= FEED_WIDGET_CONFIG.HINT_SHOW_DAYS
                ? `${question.text.substring(0, 40)}...`
                : undefined),
            // SECURITY: fullDescription removed - could leak question text for cheating
            source: "Prediction Market",
            relatedQuestion: question.questionNumber,
          });
        }

        // 2. Get upcoming world events - dynamically determine event types from database
        // First, get all unique event types that could be upcoming events
        // Use groupBy to get distinct event types
        const uniqueEventTypesRaw = await db.worldEvent.groupBy({
          by: ["eventType"],
          where: {
            timestamp: {
              gte: new Date(), // Only future events
            },
          },
          take: 20,
        });

        const uniqueEventTypes = uniqueEventTypesRaw.map((e) => ({
          eventType: e.eventType as string,
        }));

        const upcomingEventTypes = uniqueEventTypes
          .map((e) => e.eventType.toLowerCase())
          .filter(
            (type) =>
              type.includes("meeting") ||
              type.includes("announcement") ||
              type.includes("summit") ||
              type.includes("conference") ||
              type.includes("scheduled"),
          );

        // Build the eventType filter, ensuring all values are strings (no undefined)
        const eventTypeFilter: string[] =
          upcomingEventTypes.length > 0
            ? Array.from(
                new Set(
                  upcomingEventTypes
                    .map(
                      (t) =>
                        uniqueEventTypes.find(
                          (e) => e.eventType.toLowerCase() === t,
                        )?.eventType,
                    )
                    .filter(
                      (type): type is string =>
                        typeof type === "string" && type !== undefined,
                    ),
                ),
              )
            : [];

        const upcomingWorldEvents = await db.worldEvent.findMany({
          where: {
            timestamp: {
              gte: new Date(), // Future events only
              lte: new Date(
                Date.now() +
                  FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS * 24 * 60 * 60 * 1000,
              ),
            },
            visibility: "public", // Only show public events
            ...(eventTypeFilter.length > 0
              ? {
                  eventType: {
                    in: eventTypeFilter,
                  },
                }
              : {}),
          },
          orderBy: {
            timestamp: "asc",
          },
          take: FEED_WIDGET_CONFIG.MAX_UPCOMING_EVENTS,
        });

        for (const event of upcomingWorldEvents) {
          const eventDate = new Date(event.timestamp);
          const description = event.description || "Event scheduled";

          const dateStr = eventDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          const timeStr = eventDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });

          const hoursUntil =
            (eventDate.getTime() - Date.now()) / (1000 * 60 * 60);
          const isLive =
            hoursUntil <= FEED_WIDGET_CONFIG.LIVE_EVENT_HOURS &&
            hoursUntil >= 0;

          // Generate title from event type dynamically
          let title =
            description.length > 40
              ? `${description.substring(0, 37)}...`
              : description;
          const eventTypeLower = event.eventType.toLowerCase();
          if (eventTypeLower.includes("announcement"))
            title = "Major Announcement";
          else if (eventTypeLower.includes("meeting")) title = "Key Meeting";
          else if (eventTypeLower.includes("development"))
            title = "New Development";
          else if (eventTypeLower.includes("summit")) title = "Industry Summit";
          else if (eventTypeLower.includes("conference"))
            title = "Tech Conference";

          eventsList.push({
            id: event.id,
            title,
            date: dateStr,
            time: timeStr,
            isLive,
            hint:
              description.length > 60
                ? `${description.substring(0, 57)}...`
                : description,
            // SECURITY: fullDescription removed from world events too
            source: event.relatedQuestion
              ? `World Event (Related to Question #${event.relatedQuestion})`
              : "World Event",
            relatedQuestion:
              typeof event.relatedQuestion === "number"
                ? event.relatedQuestion
                : undefined,
          });
        }

        // Sort by date/time and take top N
        const sortedEvents = eventsList
          .sort((a, b) => {
            const dateA = new Date(`${a.date} ${a.time || ""}`).getTime();
            const dateB = new Date(`${b.date} ${b.time || ""}`).getTime();
            return dateA - dateB;
          })
          .slice(0, FEED_WIDGET_CONFIG.MAX_UPCOMING_EVENTS);

        return sortedEvents;
      })
    : await asPublic(async (db) => {
        const eventsList: UpcomingEvent[] = [];

        // 1. Get active questions that will resolve soon (within configured days)
        const activeQuestions = await db.question.findMany({
          where: {
            status: "active",
            resolutionDate: {
              gte: new Date(), // Only future resolutions
              lte: new Date(
                Date.now() +
                  FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS * 24 * 60 * 60 * 1000,
              ),
            },
          },
          orderBy: {
            resolutionDate: "asc",
          },
          take: 10,
        });

        // Transform questions into upcoming events (hinting but not revealing)
        for (const question of activeQuestions) {
          const resolutionDate = new Date(question.resolutionDate);
          const now = new Date();
          const daysUntil = Math.ceil(
            (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );

          if (
            daysUntil > FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS ||
            daysUntil < 0
          )
            continue;

          // Check if it's happening soon (within configured hours = "LIVE")
          const hoursUntil =
            (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60);
          const isLive =
            hoursUntil <= FEED_WIDGET_CONFIG.LIVE_EVENT_HOURS &&
            hoursUntil >= 0;

          // Generate event title based on question content
          let title = "Market Resolution";
          const questionText = question.text.toLowerCase();

          if (
            questionText.includes("earnings") ||
            questionText.includes("financial")
          ) {
            title = "Earnings Report";
          } else if (
            questionText.includes("meeting") ||
            questionText.includes("fed") ||
            questionText.includes("conference")
          ) {
            title = "Fed Meeting";
          } else if (
            questionText.includes("summit") ||
            questionText.includes("conference")
          ) {
            title = "AI Summit 2025";
          } else if (
            questionText.includes("launch") ||
            questionText.includes("release")
          ) {
            title = "Product Launch";
          } else if (
            questionText.includes("announcement") ||
            questionText.includes("announces")
          ) {
            title = "Major Announcement";
          } else if (
            questionText.includes("trial") ||
            questionText.includes("court")
          ) {
            title = "Court Ruling";
          } else if (
            questionText.includes("election") ||
            questionText.includes("vote")
          ) {
            title = "Election Results";
          }

          // Format date and time
          const eventDate = resolutionDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          const eventTime = resolutionDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });

          // Only show hint if very soon (within configured days) - subtle tease without revealing
          let hint: string | undefined;
          if (
            daysUntil <= FEED_WIDGET_CONFIG.HINT_SHOW_DAYS &&
            question.text.length > 0
          ) {
            // Extract key words/phrases without revealing the full question
            const words = question.text.split(" ").filter((w) => w.length > 4);
            if (words.length > 0) {
              const keyPhrase = words.slice(0, 3).join(" ");
              hint =
                keyPhrase.length > 40
                  ? `${keyPhrase.substring(0, 37)}...`
                  : keyPhrase;
            }
          }

          eventsList.push({
            id: question.id,
            title,
            date: eventDate,
            time: eventTime,
            isLive,
            hint:
              hint ||
              (daysUntil <= FEED_WIDGET_CONFIG.HINT_SHOW_DAYS
                ? `${question.text.substring(0, 40)}...`
                : undefined),
            // SECURITY: fullDescription removed - could leak question text for cheating
            source: "Prediction Market",
            relatedQuestion: question.questionNumber,
          });
        }

        // 2. Get upcoming world events - dynamically determine event types from database
        // First, get all unique event types that could be upcoming events
        // Use groupBy to get distinct event types
        const uniqueEventTypesRaw = await db.worldEvent.groupBy({
          by: ["eventType"],
          where: {
            timestamp: {
              gte: new Date(), // Only future events
            },
          },
          take: 20,
        });

        const uniqueEventTypes = uniqueEventTypesRaw.map((e) => ({
          eventType: e.eventType as string,
        }));

        const upcomingEventTypes = uniqueEventTypes
          .map((e) => e.eventType.toLowerCase())
          .filter(
            (type) =>
              type.includes("meeting") ||
              type.includes("announcement") ||
              type.includes("summit") ||
              type.includes("conference") ||
              type.includes("scheduled"),
          );

        // Build the eventType filter, ensuring all values are strings (no undefined)
        const eventTypeFilter: string[] =
          upcomingEventTypes.length > 0
            ? Array.from(
                new Set(
                  upcomingEventTypes
                    .map(
                      (t) =>
                        uniqueEventTypes.find(
                          (e) => e.eventType.toLowerCase() === t,
                        )?.eventType,
                    )
                    .filter(
                      (type): type is string =>
                        typeof type === "string" && type !== undefined,
                    ),
                ),
              )
            : [];

        const upcomingWorldEvents = await db.worldEvent.findMany({
          where: {
            timestamp: {
              gte: new Date(), // Future events only
              lte: new Date(
                Date.now() +
                  FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS * 24 * 60 * 60 * 1000,
              ),
            },
            visibility: "public", // Only show public events
            ...(eventTypeFilter.length > 0
              ? {
                  eventType: {
                    in: eventTypeFilter,
                  },
                }
              : {}),
          },
          orderBy: {
            timestamp: "asc",
          },
          take: FEED_WIDGET_CONFIG.MAX_UPCOMING_EVENTS,
        });

        for (const event of upcomingWorldEvents) {
          const eventDate = new Date(event.timestamp);
          const description = event.description || "Event scheduled";

          const dateStr = eventDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          const timeStr = eventDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });

          const hoursUntil =
            (eventDate.getTime() - Date.now()) / (1000 * 60 * 60);
          const isLive =
            hoursUntil <= FEED_WIDGET_CONFIG.LIVE_EVENT_HOURS &&
            hoursUntil >= 0;

          // Generate title from event type dynamically
          let title =
            description.length > 40
              ? `${description.substring(0, 37)}...`
              : description;
          const eventTypeLower = event.eventType.toLowerCase();
          if (eventTypeLower.includes("announcement"))
            title = "Major Announcement";
          else if (eventTypeLower.includes("meeting")) title = "Key Meeting";
          else if (eventTypeLower.includes("development"))
            title = "New Development";
          else if (eventTypeLower.includes("summit")) title = "Industry Summit";
          else if (eventTypeLower.includes("conference"))
            title = "Tech Conference";

          eventsList.push({
            id: event.id,
            title,
            date: dateStr,
            time: timeStr,
            isLive,
            hint:
              description.length > 60
                ? `${description.substring(0, 57)}...`
                : description,
            // SECURITY: fullDescription removed from world events too
            source: event.relatedQuestion
              ? `World Event (Related to Question #${event.relatedQuestion})`
              : "World Event",
            relatedQuestion:
              typeof event.relatedQuestion === "number"
                ? event.relatedQuestion
                : undefined,
          });
        }

        // Sort by date/time and take top N
        const sortedEvents = eventsList
          .sort((a, b) => {
            const dateA = new Date(`${a.date} ${a.time || ""}`).getTime();
            const dateB = new Date(`${b.date} ${b.time || ""}`).getTime();
            return dateA - dateB;
          })
          .slice(0, FEED_WIDGET_CONFIG.MAX_UPCOMING_EVENTS);

        return sortedEvents;
      });

  logger.info(
    "Upcoming events fetched successfully",
    { count: events.length },
    "GET /api/feed/widgets/upcoming-events",
  );

  return successResponse({
    success: true,
    events: events,
  });
});
