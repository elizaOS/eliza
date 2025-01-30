export class HyperbolicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperbolicError';
    Object.setPrototypeOf(this, HyperbolicError.prototype);
  }
}

export class ConfigurationError extends HyperbolicError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

export class APIError extends HyperbolicError {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'APIError';
    Object.setPrototypeOf(this, APIError.prototype);
  }
}

export class ValidationError extends HyperbolicError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class SSHError extends HyperbolicError {
  constructor(message: string) {
    super(message);
    this.name = 'SSHError';
    Object.setPrototypeOf(this, SSHError.prototype);
  }
}

export class GPUError extends HyperbolicError {
  constructor(message: string) {
    super(message);
    this.name = 'GPUError';
    Object.setPrototypeOf(this, GPUError.prototype);
  }
}
