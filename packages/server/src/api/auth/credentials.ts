import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Generate JWT token for authenticated user.
 *
 * @param username - User's username
 * @param email - User's email
 * @returns JWT token string
 */
function generateAuthToken(username: string, email: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }

  // Create deterministic sub from username
  const sub = `eliza:${username}`;

  // Generate deterministic entityId
  const entityId = stringToUuid(sub) as UUID;

  const payload = {
    sub,
    iss: 'eliza-server',
    entityId,
    username,
    email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
  };

  return jwt.sign(payload, secret);
}

/**
 * User registration and login endpoints (credentials-based auth)
 */
export function createAuthCredentialsRouter(
  serverInstance: AgentServer
): Router {
  const router = Router();
  const db = serverInstance.database;

  /**
   * POST /api/auth/register
   *
   * Register a new user account.
   *
   * Body:
   * - email: string (required, valid email)
   * - username: string (required, 3-50 chars)
   * - password: string (required, min 8 chars)
   *
   * Response:
   * - token: JWT token
   * - entityId: Generated entity UUID
   * - username: User's username
   */
  router.post('/register', async (req, res) => {
    const { email, username, password } = req.body;

    // Validation
    if (!email || !email.includes('@')) {
      return sendError(res, 400, 'INVALID_EMAIL', 'Invalid email address');
    }

    if (!username || username.length < 3 || username.length > 50) {
      return sendError(
        res,
        400,
        'INVALID_USERNAME',
        'Username must be between 3 and 50 characters'
      );
    }

    if (!password || password.length < 8) {
      return sendError(
        res,
        400,
        'INVALID_PASSWORD',
        'Password must be at least 8 characters'
      );
    }

    try {
      // Check if email already exists
      const existingUser = await db.getUserByEmail(email.toLowerCase());

      if (existingUser) {
        return sendError(res, 409, 'EMAIL_EXISTS', 'Email already registered');
      }

      // Check if username already exists
      const existingUsername = await db.getUserByUsername(username);

      if (existingUsername) {
        return sendError(
          res,
          409,
          'USERNAME_EXISTS',
          'Username already taken'
        );
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const userId = uuidv4() as UUID;
      await db.createUser({
        id: userId,
        email: email.toLowerCase(),
        username,
        passwordHash,
      });

      // Generate JWT token
      const token = generateAuthToken(username, email);

      // Calculate entityId (same as in JWT)
      const entityId = stringToUuid(`eliza:${username}`) as UUID;

      logger.info(
        `[Auth] New user registered: ${email} (entityId: ${entityId.substring(0, 8)}...)`
      );

      return sendSuccess(res, {
        token,
        entityId,
        username,
        expiresIn: '7d',
      }, 201);
    } catch (error: any) {
      logger.error('[Auth] Registration error:', error);
      return sendError(
        res,
        500,
        'REGISTRATION_FAILED',
        'Registration failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * POST /api/auth/login
   *
   * Authenticate existing user.
   *
   * Body:
   * - email: string (required)
   * - password: string (required)
   *
   * Response:
   * - token: JWT token
   * - entityId: Entity UUID
   * - username: User's username
   */
  router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(
        res,
        400,
        'MISSING_CREDENTIALS',
        'Email and password required'
      );
    }

    try {
      // Find user by email
      const user = await db.getUserByEmail(email.toLowerCase());

      if (!user) {
        return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(
        password,
        user.passwordHash
      );

      if (!isValidPassword) {
        logger.warn(`[Auth] Failed login attempt for ${email}`);
        return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      // Update last login timestamp
      await db.updateUserLastLogin(user.id);

      // Generate JWT token
      const token = generateAuthToken(user.username, user.email);

      // Calculate entityId
      const entityId = stringToUuid(`eliza:${user.username}`) as UUID;

      logger.info(
        `[Auth] User logged in: ${email} (entityId: ${entityId.substring(0, 8)}...)`
      );

      return sendSuccess(res, {
        token,
        entityId,
        username: user.username,
        expiresIn: '7d',
      });
    } catch (error: any) {
      logger.error('[Auth] Login error:', error);
      return sendError(
        res,
        500,
        'LOGIN_FAILED',
        'Login failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * POST /api/auth/refresh
   *
   * Refresh JWT token to extend session (requires valid non-expired token).
   *
   * Headers:
   * - Authorization: Bearer <token>
   *
   * Response:
   * - token: New JWT token
   * - entityId: Entity UUID
   * - username: User's username
   */
  router.post('/refresh', async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 401, 'MISSING_TOKEN', 'No token provided');
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      logger.error('[Auth] JWT_SECRET not configured');
      return sendError(res, 500, 'SERVER_ERROR', 'Server misconfiguration');
    }

    try {
      // Verify current token
      const decoded = jwt.verify(token, secret) as {
        username: string;
        email: string;
        entityId: UUID;
      };

      // Generate new token with fresh expiration
      const newToken = generateAuthToken(decoded.username, decoded.email);

      logger.info(
        `[Auth] Token refreshed for ${decoded.username} (entityId: ${decoded.entityId.substring(0, 8)}...)`
      );

      return sendSuccess(res, {
        token: newToken,
        entityId: decoded.entityId,
        username: decoded.username,
        expiresIn: '7d',
      });
    } catch (error: any) {
      logger.warn('[Auth] Token refresh failed:', error.message);
      return sendError(
        res,
        401,
        'INVALID_TOKEN',
        'Invalid or expired token'
      );
    }
  });

  /**
   * GET /api/auth/me
   *
   * Get current authenticated user information.
   *
   * Headers:
   * - Authorization: Bearer <token>
   *
   * Response:
   * - entityId: Entity UUID
   * - email: User's email
   * - username: User's username
   */
  router.get('/me', async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 401, 'MISSING_TOKEN', 'No token provided');
    }

    const token = authHeader.substring(7);
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      logger.error('[Auth] JWT_SECRET not configured');
      return sendError(res, 500, 'SERVER_ERROR', 'Server misconfiguration');
    }

    try {
      // Verify and decode token
      const decoded = jwt.verify(token, secret) as {
        username: string;
        email: string;
        entityId: UUID;
      };

      return sendSuccess(res, {
        entityId: decoded.entityId,
        email: decoded.email,
        username: decoded.username,
      });
    } catch (error: any) {
      logger.warn('[Auth] Authentication failed:', error.message);
      return sendError(
        res,
        401,
        'INVALID_TOKEN',
        'Invalid or expired token'
      );
    }
  });

  return router;
}