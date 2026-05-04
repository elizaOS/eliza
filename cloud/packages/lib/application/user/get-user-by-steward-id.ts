import type { UserWithOrganization } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class GetUserByStewardIdUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(stewardUserId: string): Promise<UserWithOrganization | undefined> {
    return this.users.findByStewardId(stewardUserId);
  }
}
