import { Router } from 'express';
import bcrypt from 'bcrypt';
import { SignJWT, jwtVerify } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';
import { createAuthRateLimit } from '../../middleware/rate-limit';

/**
 * Generate JWT token for authenticated user.
 */
async function generateAuthToken(username: string, email: string): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }

  const sub = `eliza:${username}`;
  const secretBytes = new TextEncoder().encode(secret);

  const token = await new SignJWT({
    sub,
    iss: 'eliza-server',
    username,
    email,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('eliza-server')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretBytes);

  return token;
}

/**
 * User registration and login endpoints (credentials-based auth)
 */
export function createAuthCredentialsRouter(serverInstance: AgentServer): Router {
  const router = Router();
  const db = serverInstance.database;
  const authRateLimit = createAuthRateLimit();

  /**
   * POST /api/auth/register
   */
  router.post('/register', authRateLimit, async (req, res) => {
    const { email, username, password } = req.body;

    if (!email || !email.includes('@')) {
      return sendError(res, 400, 'INVALID_EMAIL', 'Invalid email address');
    }

    if (!username || username.length < 3 || username.length > 50) {
      return sendError(res, 400, 'INVALID_USERNAME', 'Username must be between 3 and 50 characters');
    }

    if (!password || password.length < 8) {
      return sendError(res, 400, 'INVALID_PASSWORD', 'Password must be at least 8 characters');
    }

    try {
      const existingUser = await db.getUserByEmail(email.toLowerCase());
      if (existingUser) {
        return sendError(res, 409, 'EMAIL_EXISTS', 'Email already registered');
      }

      const existingUsername = await db.getUserByUsername(username);
      if (existingUsername) {
        return sendError(res, 409, 'USERNAME_EXISTS', 'Username already taken');
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const userId = uuidv4() as UUID;

      await db.createUser({
        id: userId,
        email: email.toLowerCase(),
        username,
        passwordHash,
      });

      const token = await generateAuthToken(username, email);
      const entityId = stringToUuid(`eliza:${username}`) as UUID;

      logger.info({ src: 'http', path: '/auth/register', entityId }, 'User registered');

      return sendSuccess(res, { token, entityId, username, expiresIn: '7d' }, 201);
    } catch (error: any) {
      logger.error({ src: 'http', path: '/auth/register', error: error.message }, 'Registration failed');
      return sendError(res, 500, 'REGISTRATION_FAILED', 'Registration failed', error.message);
    }
  });

  /**
   * POST /api/auth/login
   */
  router.post('/login', authRateLimit, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 400, 'MISSING_CREDENTIALS', 'Email and password required');
    }

    try {
      const user = await db.getUserByEmail(email.toLowerCase());

      if (!user) {
        logger.warn({ src: 'http', ip: req.ip, path: '/auth/login' }, 'Login failed - user not found');
        return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      const isValidPassword = await bcrypt.compare(password, user.passwordHash);

      if (!isValidPassword) {
        logger.warn({ src: 'http', ip: req.ip, path: '/auth/login' }, 'Login failed - invalid password');
        return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      await db.updateUserLastLogin(user.id);

      const token = await generateAuthToken(user.username, user.email);
      const entityId = stringToUuid(`eliza:${user.username}`) as UUID;

      logger.info({ src: 'http', path: '/auth/login', entityId }, 'User logged in');

      return sendSuccess(res, { token, entityId, username: user.username, expiresIn: '7d' });
    } catch (error: any) {
      logger.error({ src: 'http', path: '/auth/login', error: error.message }, 'Login failed');
      return sendError(res, 500, 'LOGIN_FAILED', 'Login failed', error.message);
    }
  });

  /**
   * POST /api/auth/refresh
   */
  router.post('/refresh', async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 401, 'MISSING_TOKEN', 'No token provided');
    }

    const token = authHeader.substring(7);
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      logger.error({ src: 'http', path: '/auth/refresh' }, 'JWT_SECRET not configured');
      return sendError(res, 500, 'SERVER_ERROR', 'Server misconfiguration');
    }

    try {
      const secretBytes = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, secretBytes);

      const sub = payload.sub as string;
      const username = payload.username as string;
      const email = payload.email as string;
      const entityId = stringToUuid(sub) as UUID;

      const newToken = await generateAuthToken(username, email);

      return sendSuccess(res, {
        token: newToken,
        entityId,
        username,
        expiresIn: '7d',
      });
    } catch (error: any) {
      logger.warn({ src: 'http', ip: req.ip, path: '/auth/refresh', error: error.message }, 'Token refresh failed');
      return sendError(res, 401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
  });

  /**
   * GET /api/auth/me
   */
  router.get('/me', async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 401, 'MISSING_TOKEN', 'No token provided');
    }

    const token = authHeader.substring(7);
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      logger.error({ src: 'http', path: '/auth/me' }, 'JWT_SECRET not configured');
      return sendError(res, 500, 'SERVER_ERROR', 'Server misconfiguration');
    }

    try {
      const secretBytes = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, secretBytes);

      const sub = payload.sub as string;
      const entityId = stringToUuid(sub) as UUID;

      return sendSuccess(res, {
        entityId,
        email: payload.email as string,
        username: payload.username as string,
      });
    } catch (error: any) {
      logger.warn({ src: 'http', ip: req.ip, path: '/auth/me', error: error.message }, 'Authentication failed');
      return sendError(res, 401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
  });

  return router;
}
