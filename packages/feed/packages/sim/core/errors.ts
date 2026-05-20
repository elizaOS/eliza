/**
 * Framework error types.
 */

export class FrameworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameworkError';
  }
}

export class SystemNotFoundError extends FrameworkError {
  constructor(systemId: string, requiredBy: string) {
    super(
      `System "${systemId}" not found (required by "${requiredBy}"). ` +
        `Ensure the system is registered before the dependent system.`
    );
    this.name = 'SystemNotFoundError';
  }
}

export class CircularDependencyError extends FrameworkError {
  constructor(cycle: string[]) {
    super(
      `Circular dependency detected: ${cycle.join(' -> ')}. ` +
        `Break the cycle by removing or restructuring dependencies.`
    );
    this.name = 'CircularDependencyError';
  }
}

export class ServiceNotFoundError extends FrameworkError {
  constructor(token: string, available: string[]) {
    super(
      `Service "${token}" not found. ` +
        `Available services: [${available.join(', ')}]`
    );
    this.name = 'ServiceNotFoundError';
  }
}
