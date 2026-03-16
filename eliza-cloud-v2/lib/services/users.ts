/**
 * Users service for managing user accounts and organization relationships.
 */

import {
  usersRepository,
  organizationsRepository,
  type User,
  type NewUser,
  type UserWithOrganization,
} from "@/db/repositories";

/**
 * Service for user operations including organization lookups.
 */
export class UsersService {
  async getById(id: string): Promise<User | undefined> {
    return await usersRepository.findById(id);
  }

  async getByEmail(email: string): Promise<User | undefined> {
    return await usersRepository.findByEmail(email);
  }

  async getByPrivyId(
    privyUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    return await usersRepository.findByPrivyIdWithOrganization(privyUserId);
  }

  async getWithOrganization(
    userId: string,
  ): Promise<UserWithOrganization | undefined> {
    return await usersRepository.findWithOrganization(userId);
  }

  async getByEmailWithOrganization(
    email: string,
  ): Promise<UserWithOrganization | undefined> {
    return await usersRepository.findByEmailWithOrganization(email);
  }

  async getByWalletAddress(walletAddress: string): Promise<User | undefined> {
    return await usersRepository.findByWalletAddress(walletAddress);
  }

  async getByWalletAddressWithOrganization(
    walletAddress: string,
  ): Promise<UserWithOrganization | undefined> {
    return await usersRepository.findByWalletAddressWithOrganization(
      walletAddress,
    );
  }

  async listByOrganization(organizationId: string): Promise<User[]> {
    return await usersRepository.listByOrganization(organizationId);
  }

  async create(data: NewUser): Promise<User> {
    return await usersRepository.create(data);
  }

  async update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    return await usersRepository.update(id, data);
  }

  async delete(id: string): Promise<void> {
    const user = await this.getById(id);

    if (!user) {
      throw new Error(`User ${id} not found`);
    }

    const organizationId = user.organization_id;

    await usersRepository.delete(id);

    // Check if this was the last user in the organization
    if (organizationId) {
      const remainingUsers =
        await usersRepository.listByOrganization(organizationId);

      // If no users remain, delete the organization
      if (remainingUsers.length === 0) {
        await organizationsRepository.delete(organizationId);
      }
    }
  }
}

// Export singleton instance
export const usersService = new UsersService();
