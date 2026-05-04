import type { NewUser, User } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class UpdateUserUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    return this.users.update(id, data);
  }
}
