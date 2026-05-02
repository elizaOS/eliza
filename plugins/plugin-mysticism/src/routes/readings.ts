import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { logger } from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";
import type { BirthData, ReadingSession, ReadingSystem } from "../types";

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface TarotRequestBody {
  entityId: string;
  roomId: string;
  question: string;
  spreadId: string;
}

interface IChingRequestBody {
  entityId: string;
  roomId: string;
  question: string;
}

interface AstrologyRequestBody {
  entityId: string;
  roomId: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  birthHour: number;
  birthMinute: number;
  latitude: number;
  longitude: number;
  timezone: number;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

type RouteBody = Record<string, string | number | boolean | null | undefined> | undefined;

function validateTarotBody(body: RouteBody): TarotRequestBody | string {
  if (!body) return "Request body is required";
  if (typeof body.entityId !== "string" || !body.entityId) return "entityId is required";
  if (typeof body.roomId !== "string" || !body.roomId) return "roomId is required";
  if (typeof body.question !== "string" || !body.question) return "question is required";

  return {
    entityId: body.entityId,
    roomId: body.roomId,
    question: body.question,
    spreadId: typeof body.spreadId === "string" ? body.spreadId : "three_card",
  };
}

function validateIChingBody(body: RouteBody): IChingRequestBody | string {
  if (!body) return "Request body is required";
  if (typeof body.entityId !== "string" || !body.entityId) return "entityId is required";
  if (typeof body.roomId !== "string" || !body.roomId) return "roomId is required";
  if (typeof body.question !== "string" || !body.question) return "question is required";

  return {
    entityId: body.entityId,
    roomId: body.roomId,
    question: body.question,
  };
}

function validateAstrologyBody(body: RouteBody): AstrologyRequestBody | string {
  if (!body) return "Request body is required";
  if (typeof body.entityId !== "string" || !body.entityId) return "entityId is required";
  if (typeof body.roomId !== "string" || !body.roomId) return "roomId is required";
  if (typeof body.birthYear !== "number") return "birthYear is required (number)";
  if (typeof body.birthMonth !== "number" || body.birthMonth < 1 || body.birthMonth > 12)
    return "birthMonth is required (1-12)";
  if (typeof body.birthDay !== "number" || body.birthDay < 1 || body.birthDay > 31)
    return "birthDay is required (1-31)";
  if (typeof body.birthHour !== "number" || body.birthHour < 0 || body.birthHour > 23)
    return "birthHour is required (0-23)";
  if (typeof body.birthMinute !== "number" || body.birthMinute < 0 || body.birthMinute > 59)
    return "birthMinute is required (0-59)";
  if (typeof body.latitude !== "number" || body.latitude < -90 || body.latitude > 90)
    return "latitude is required (-90 to 90)";
  if (typeof body.longitude !== "number" || body.longitude < -180 || body.longitude > 180)
    return "longitude is required (-180 to 180)";
  if (typeof body.timezone !== "number" || body.timezone < -12 || body.timezone > 14)
    return "timezone is required (-12 to 14)";

  return {
    entityId: body.entityId,
    roomId: body.roomId,
    birthYear: body.birthYear,
    birthMonth: body.birthMonth,
    birthDay: body.birthDay,
    birthHour: body.birthHour,
    birthMinute: body.birthMinute,
    latitude: body.latitude,
    longitude: body.longitude,
    timezone: body.timezone,
  };
}

// ---------------------------------------------------------------------------
// Generic POST handler factory
// ---------------------------------------------------------------------------

function readingRoute<T extends { entityId: string }>(
  path: string,
  type: ReadingSystem,
  validate: (body: RouteBody) => T | string,
  startReading: (service: MysticismService, body: T) => ReadingSession,
  successMessage: string
): Route {
  return {
    path,
    type: "POST",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ): Promise<void> => {
      try {
        const service = runtime.getService<MysticismService>("MYSTICISM");
        if (!service) {
          res.status(503).json({ success: false, error: "Mysticism service is not available" });
          return;
        }

        const validated = validate(req.body as RouteBody);
        if (typeof validated === "string") {
          res.status(400).json({ success: false, error: validated });
          return;
        }

        const session = startReading(service, validated);

        logger.info(
          `[ReadingRoutes] ${type} reading started: ${session.id} (entity: ${validated.entityId})`
        );

        res.status(201).json({
          success: true,
          sessionId: session.id,
          type,
          phase: session.phase,
          message: successMessage,
        });
      } catch (error) {
        logger.error(`[ReadingRoutes] ${type} reading error:`, String(error));
        res.status(500).json({ success: false, error: `Failed to start ${type} reading` });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function createReadingRoutes(): Route[] {
  return [
    readingRoute<TarotRequestBody>(
      "/api/readings/tarot",
      "tarot",
      validateTarotBody,
      (svc, b) => svc.startTarotReading(b.entityId, b.roomId, b.spreadId, b.question),
      "Your tarot reading has been prepared. The cards are drawn and waiting."
    ),

    readingRoute<IChingRequestBody>(
      "/api/readings/iching",
      "iching",
      validateIChingBody,
      (svc, b) => svc.startIChingReading(b.entityId, b.roomId, b.question),
      "The coins have been cast. Your hexagram is ready for interpretation."
    ),

    readingRoute<AstrologyRequestBody>(
      "/api/readings/astrology",
      "astrology",
      validateAstrologyBody,
      (svc, b) => {
        const birthData: BirthData = {
          year: b.birthYear,
          month: b.birthMonth,
          day: b.birthDay,
          hour: b.birthHour,
          minute: b.birthMinute,
          latitude: b.latitude,
          longitude: b.longitude,
          timezone: b.timezone,
        };
        return svc.startAstrologyReading(b.entityId, b.roomId, birthData);
      },
      "Your natal chart has been calculated. The stars are ready to speak."
    ),

    // GET /api/readings/status — public polling endpoint
    {
      name: "reading-status",
      public: true,
      path: "/api/readings/status",
      type: "GET",
      handler: async (
        req: RouteRequest,
        res: RouteResponse,
        runtime: IAgentRuntime
      ): Promise<void> => {
        try {
          const service = runtime.getService<MysticismService>("MYSTICISM");
          if (!service) {
            res.status(503).json({ success: false, error: "Mysticism service is not available" });
            return;
          }

          const entityId = req.query?.entityId as string | undefined;
          const roomId = req.query?.roomId as string | undefined;
          if (!entityId || !roomId) {
            res.status(400).json({
              success: false,
              error: "entityId and roomId query parameters are required",
            });
            return;
          }

          const session = service.getSession(entityId, roomId);
          if (!session) {
            res.status(404).json({ success: false, error: "Reading session not found" });
            return;
          }

          res.status(200).json({
            success: true,
            session: {
              id: session.id,
              type: session.type,
              phase: session.phase,
              paymentStatus: session.paymentStatus,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
          });
        } catch (error) {
          logger.error("[ReadingRoutes] Status check error:", String(error));
          res.status(500).json({ success: false, error: "Failed to retrieve reading status" });
        }
      },
    },
  ];
}
