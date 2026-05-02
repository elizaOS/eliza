/**
 * Bun 1.3.9+ validates `mock.module` factories: runtime named exports must match the source module.
 * Partial mocks that omit `UsersRepository` / `CreditsService` / etc. break `export *` re-exports
 * (e.g. `@/db/repositories`) and later imports in the same process.
 */

const parsedCostBuffer = Number.parseFloat(process.env.CREDIT_COST_BUFFER ?? "");
const COST_BUFFER = Number.isFinite(parsedCostBuffer) ? parsedCostBuffer : 1.5;
const MIN_RESERVATION = 0.000001;
const { UsersRepository: RealUsersRepository } = await import("@/db/repositories/users");

/** Minimal interface for stubbing usersRepository in tests. */
type UsersRepositoryStub = Partial<InstanceType<typeof RealUsersRepository>>;

/** Shape returned by stubUsersRepositoryModule matching the real module exports. */
interface UsersRepositoryModuleStub<TUsersRepository extends UsersRepositoryStub> {
  UsersRepository: typeof RealUsersRepository;
  usersRepository: TUsersRepository;
}

export function stubUsersRepositoryModule<TUsersRepository extends UsersRepositoryStub>(overrides: {
  usersRepository: TUsersRepository;
}): UsersRepositoryModuleStub<TUsersRepository> {
  return {
    UsersRepository: RealUsersRepository,
    usersRepository: overrides.usersRepository,
  };
}

export const creditsModuleRuntimeShim = {
  COST_BUFFER,
  MIN_RESERVATION,
  EPSILON: MIN_RESERVATION * 0.1,
  DEFAULT_OUTPUT_TOKENS: 500,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    public readonly required: number;
    public readonly available: number;
    public readonly reason?: string;

    constructor(required: number, available: number, reason?: string) {
      super(
        `Insufficient credits. Required: $${required.toFixed(4)}, Available: $${available.toFixed(4)}`,
      );
      this.name = "InsufficientCreditsError";
      this.required = required;
      this.available = available;
      this.reason = reason;
    }
  },
  CreditsService: class CreditsService {},
};
