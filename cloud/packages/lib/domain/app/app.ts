import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { apps } from "@/db/schemas/apps";

export type App = InferSelectModel<typeof apps>;
export type NewApp = InferInsertModel<typeof apps>;
