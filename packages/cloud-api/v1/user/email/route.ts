/**
 * PATCH /api/v1/user/email
 *
 * Adds an email address to the authenticated user's account. Only allowed
 * when the user has no email currently set — changing an existing email
 * still requires support intervention.
 *
 * Mirrors `_legacy_actions/users.ts → updateEmail`.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { usersService } from "@/lib/services/users";
import type { AppEnv } from "@/types/cloud-worker-env";

const updateEmailSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.patch("/", async (c) => {
  try {
    const authed = await requireUserOrApiKey(c);
    const fullUser = await usersService.getById(authed.id);

    if (fullUser?.email) {
      return c.json(
        {
          success: false,
          error: "Email already set. Please contact support to change your email.",
        },
        400,
      );
    }

    const body = await c.req.json();
    const parsed = updateEmailSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid email address" },
        400,
      );
    }

    const lower = parsed.data.email.toLowerCase().trim();

    const existingUser = await usersService.getByEmail(lower);
    if (existingUser && existingUser.id !== authed.id) {
      return c.json(
        { success: false, error: "This email is already in use by another account." },
        409,
      );
    }

    await usersService.update(authed.id, {
      email: lower,
      email_verified: false,
    });

    return c.json({
      success: true,
      message: "Email added successfully! Please check your inbox to verify.",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
