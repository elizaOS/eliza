import { usersRepository } from "@/db/repositories";
import type {
  NewUser,
  User,
  UserWithOrganization,
} from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class PostgresUserRepository implements UserRepository {
  findById(id: string): Promise<User | undefined> {
    return usersRepository.findById(id);
  }

  findByEmail(email: string): Promise<User | undefined> {
    return usersRepository.findByEmail(email);
  }

  findByStewardId(
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    return usersRepository.findByStewardIdWithOrganization(stewardUserId);
  }

  findWithOrganization(
    userId: string,
  ): Promise<UserWithOrganization | undefined> {
    return usersRepository.findWithOrganization(userId);
  }

  listByOrganization(organizationId: string): Promise<User[]> {
    return usersRepository.listByOrganization(organizationId);
  }

  create(data: NewUser): Promise<User> {
    return usersRepository.create(data);
  }

  update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    return usersRepository.update(id, data);
  }

  delete(id: string): Promise<void> {
    return usersRepository.delete(id);
  }

  // No-op — caching lives in CachedUserRepository.
  async invalidateCache(_user: User | UserWithOrganization): Promise<void> {
    // intentionally empty
  }
}
