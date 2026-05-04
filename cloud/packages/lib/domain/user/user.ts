import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { users } from "@/db/schemas/users";
import type { Organization } from "@/lib/domain/organization/organization";

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type UserWithOrganization = User & {
  organization?: Organization | null;
};
