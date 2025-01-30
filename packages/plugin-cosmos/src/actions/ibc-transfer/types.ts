import type { z } from "zod";
import type { IBCTransferParamsSchema } from "./schema";

export type IBCTransferActionParams = z.infer<typeof IBCTransferParamsSchema>;
