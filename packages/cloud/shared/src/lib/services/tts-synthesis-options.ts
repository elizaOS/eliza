import { z } from "zod";

/** Provider rendering controls. Context is bounded explicitly, never truncated. */
export const TtsSynthesisOptions = z.object({
  speed: z.number().min(0.7).max(1.2).optional(),
  previousText: z.string().max(5000).optional(),
  nextText: z.string().max(5000).optional(),
  applyTextNormalization: z.enum(["auto", "on", "off"]).optional(),
});
export type TtsSynthesisOptions = z.infer<typeof TtsSynthesisOptions>;

export function hasTtsSynthesisOptions(options: TtsSynthesisOptions): boolean {
  return (
    options.speed !== undefined ||
    options.previousText !== undefined ||
    options.nextText !== undefined ||
    options.applyTextNormalization !== undefined
  );
}
