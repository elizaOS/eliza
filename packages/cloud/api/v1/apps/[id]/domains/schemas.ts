// Handles v1 cloud API v1 apps id domains schemas route traffic with route-local auth expectations.
import { z } from "zod";

/**
 * Canonical domain-name field shared by every `/apps/:id/domains/*` route.
 *
 * One definition keeps the acceptance criteria identical across attach, buy,
 * check, status and verify: bounded length, hostname format, and a
 * lowercase/trim normalization applied before the value reaches a service.
 */
export const domainField = z
  .string()
  .min(4)
  .max(253)
  .regex(
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i,
    "Invalid domain format",
  )
  .transform((d) => d.toLowerCase().trim());

export const domainBodySchema = z.object({ domain: domainField });
