import type { UserRepository } from "@/lib/domain/user/user-repository";

export class DeleteUserUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(id: string): Promise<void> {
    return this.users.delete(id);
  }
}
