import type { NewUser, User } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class CreateUserUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(data: NewUser): Promise<User> {
    return this.users.create(data);
  }
}
