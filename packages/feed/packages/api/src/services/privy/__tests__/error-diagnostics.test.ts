import { describe, expect, it } from 'bun:test';
import {
  extractPrivyApiDiagnostics,
  redactJwtLikeTokens,
} from '../error-diagnostics';

const JWT_LIKE = 'aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc';

describe('redactJwtLikeTokens', () => {
  it('redacts JWT-like tokens in text', () => {
    const input = `failed with token ${JWT_LIKE}`;
    const output = redactJwtLikeTokens(input);

    expect(output).toContain('[REDACTED_JWT]');
    expect(output).not.toContain(JWT_LIKE);
  });
});

describe('extractPrivyApiDiagnostics', () => {
  it('extracts provider diagnostics from error-shaped input', () => {
    const error = new Error('request failed') as Error & {
      status: number;
      headers: Record<string, string>;
      error: {
        code: string;
        message: string;
      };
    };
    error.status = 400;
    error.headers = { 'x-request-id': 'req_123' };
    error.error = {
      code: 'invalid_data',
      message: 'Invalid JWT token provided',
    };

    const diagnostics = extractPrivyApiDiagnostics(error);

    expect(diagnostics.errorName).toBe('Error');
    expect(diagnostics.errorMessage).toBe('request failed');
    expect(diagnostics.status).toBe(400);
    expect(diagnostics.providerRequestId).toBe('req_123');
    expect(diagnostics.providerCode).toBe('invalid_data');
    expect(diagnostics.providerMessage).toBe('Invalid JWT token provided');
  });

  it('redacts JWT-like strings when requested', () => {
    const error = new Error(`request failed: ${JWT_LIKE}`) as Error & {
      error: {
        message: string;
      };
    };
    error.error = { message: `provider said: ${JWT_LIKE}` };

    const diagnostics = extractPrivyApiDiagnostics(error, {
      redactJwtLike: true,
    });

    expect(diagnostics.errorMessage).toContain('[REDACTED_JWT]');
    expect(diagnostics.errorMessage).not.toContain(JWT_LIKE);
    expect(diagnostics.providerMessage).toContain('[REDACTED_JWT]');
    expect(diagnostics.providerMessage).not.toContain(JWT_LIKE);
  });
});
