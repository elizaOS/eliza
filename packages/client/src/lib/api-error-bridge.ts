import { ApiError } from '@elizaos/api-client';
import { connectionStatusActions } from '../context/ConnectionContext';

export function handleApiError(error: unknown): never {
  if (error instanceof ApiError) {
    // Map new API errors to old error handling patterns
    if (error.status === 401) {
      connectionStatusActions.setUnauthorized(
        error.message || 'Unauthorized access. Please check your API key.'
      );
    } else if (error.status === 403) {
      connectionStatusActions.setUnauthorized(error.message || 'Access forbidden.');
    } else if (error.status >= 500) {
      // Server errors
      throw new Error(error.message || 'Server error occurred');
    } else if (error.status >= 400) {
      // Client errors
      throw new Error(error.message || 'Request failed');
    }

    // For other status codes, throw as generic error
    throw new Error(error.message || `Request failed with status ${error.status}`);
  }

  // Handle network errors or other unknown errors
  if (error instanceof Error) {
    throw error;
  }

  // Fallback for any other type of error
  throw new Error('An unknown error occurred');
}

export function wrapWithErrorHandling<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      return handleApiError(error);
    }
  }) as T;
}
