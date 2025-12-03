/**
 * Authentication utility functions
 */

/**
 * Checks if an error message indicates a JWT authentication error
 * @param message - The error message to check
 * @returns true if the message indicates a JWT/auth error
 */
export const isJwtAuthError = (message: string): boolean => {
  const jwtErrorPatterns = [
    'JWT token required',
    'Invalid JWT',
    'Unauthorized',
    'Authentication required',
    'Token expired',
    'jwt',
  ];

  return jwtErrorPatterns.some((pattern) =>
    message.toLowerCase().includes(pattern.toLowerCase())
  );
};
