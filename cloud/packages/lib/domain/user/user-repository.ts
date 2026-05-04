import type {
  NewUser,
  User,
  UserWithOrganization,
} from "@/lib/domain/user/user";

export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  findByStewardId(
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined>;
  findWithOrganization(
    userId: string,
  ): Promise<UserWithOrganization | undefined>;
  listByOrganization(organizationId: string): Promise<User[]>;

  create(data: NewUser): Promise<User>;
  update(id: string, data: Partial<NewUser>): Promise<User | undefined>;
  delete(id: string): Promise<void>;

  invalidateCache(user: User | UserWithOrganization): Promise<void>;
}
