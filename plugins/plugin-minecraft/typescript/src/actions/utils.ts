import { z } from "zod";

export type Vec3 = { x: number; y: number; z: number };

const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export function extractVec3(text: string): Vec3 | null {
  // Supports either JSON object or bare "x y z" numbers in the message.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        x?: number;
        y?: number;
        z?: number;
      };
      const v = vec3Schema.parse(parsed);
      return v;
    } catch {
      // fallthrough to regex
    }
  }

  const m = trimmed.match(
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/,
  );
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    return null;
  return { x, y, z };
}
