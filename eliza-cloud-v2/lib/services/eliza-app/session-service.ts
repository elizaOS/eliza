/**
 * Eliza App Session Service
 *
 * JWT-based session management for Eliza App authentication.
 * Sessions are stateless JWTs with user and organization information.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { logger } from "@/lib/utils/logger";
import { elizaAppConfig } from "./config";

export interface ElizaAppSessionPayload extends JWTPayload {
  userId: string;
  organizationId: string;
  telegramId?: string;
  phoneNumber?: string;
}

export interface SessionResult {
  token: string;
  expiresAt: Date;
}

export interface ValidatedSession {
  userId: string;
  organizationId: string;
  telegramId?: string;
  phoneNumber?: string;
}

const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const JWT_ISSUER = "eliza-app";
const JWT_AUDIENCE = "eliza-app-users";

class ElizaAppSessionService {
  private secretKey: Uint8Array;

  constructor() {
    this.secretKey = new TextEncoder().encode(elizaAppConfig.jwt.secret);
  }

  async createSession(
    userId: string,
    organizationId: string,
    identifiers?: { telegramId?: string; phoneNumber?: string },
  ): Promise<SessionResult> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + SESSION_DURATION_SECONDS) * 1000);

    const payload: ElizaAppSessionPayload = {
      userId,
      organizationId,
      ...(identifiers?.telegramId && { telegramId: identifiers.telegramId }),
      ...(identifiers?.phoneNumber && { phoneNumber: identifiers.phoneNumber }),
    };

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(userId)
      .sign(this.secretKey);

    logger.info("[ElizaAppSession] Session created", {
      userId,
      organizationId,
      expiresAt: expiresAt.toISOString(),
    });

    return { token, expiresAt };
  }

  async validateSession(token: string): Promise<ValidatedSession | null> {
    try {
      const { payload } = await jwtVerify<ElizaAppSessionPayload>(
        token,
        this.secretKey,
        {
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      );

      if (!payload.userId || !payload.organizationId) {
        logger.warn("[ElizaAppSession] Token missing required fields");
        return null;
      }

      return {
        userId: payload.userId,
        organizationId: payload.organizationId,
        telegramId: payload.telegramId,
        phoneNumber: payload.phoneNumber,
      };
    } catch (error) {
      logger.debug("[ElizaAppSession] Token validation failed", { error });
      return null;
    }
  }

  async validateAuthHeader(authHeader: string): Promise<ValidatedSession | null> {
    if (!authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);
    return this.validateSession(token);
  }
}

export const elizaAppSessionService = new ElizaAppSessionService();
