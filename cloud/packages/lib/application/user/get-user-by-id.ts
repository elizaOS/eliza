import type { User } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class GetUserByIdUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(id: string): Promise<User | undefined> {
    return this.users.findById(id);
  }
}
