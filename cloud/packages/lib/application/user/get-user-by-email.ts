import type { User } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class GetUserByEmailUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(email: string): Promise<User | undefined> {
    return this.users.findByEmail(email);
  }
}
