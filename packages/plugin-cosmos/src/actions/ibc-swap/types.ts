import {z} from "zod";
import {IBCSwapParamsSchema} from "./schema.ts";

export type IBCSwapActionParams = z.infer<typeof IBCSwapParamsSchema>;
