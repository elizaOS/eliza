import { logger } from '@elizaos/core';

/**
 * Shared database error handler that provides clear, actionable error messages
 * for common database connection and authentication issues.
 */
export class DatabaseErrorHandler {
  /**
   * Analyzes a database error and throws a new error with a clear, actionable message
   * @param error The original database error
   * @param context Additional context for the error (e.g., "during migration", "during connection test")
   * @throws Error with a clear, user-friendly message
   */
  static handleDatabaseError(error: any, context = ''): never {
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code;
    const contextPrefix = context ? `${context}: ` : '';

    logger.debug(`[DB ERROR HANDLER] ${contextPrefix}Handling database error:`, {
      code: errorCode,
      message: error.message,
      context,
    });

    if (errorCode === 'ECONNREFUSED') {
      throw new Error(
        `❌ Database connection refused${context ? ` ${context}` : ''}. Please check:\n` +
          `   • Database server is running\n` +
          `   • Host and port are correct\n` +
          `   • Firewall/network access is allowed`
      );
    } else if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN') {
      throw new Error(
        `❌ Database host not found${context ? ` ${context}` : ''}. Please check:\n` +
          `   • Database hostname is correct\n` +
          `   • DNS resolution is working\n` +
          `   • Network connectivity`
      );
    } else if (
      errorMessage.includes('password authentication failed') ||
      errorMessage.includes('invalid password') ||
      errorCode === '28P01'
    ) {
      throw new Error(
        `❌ Authentication failed - INCORRECT PASSWORD${context ? ` ${context}` : ''}\n` +
          `   • Please check your database password in the connection string\n` +
          `   • Verify the password in your Supabase/database dashboard\n` +
          `   • Consider resetting the database password`
      );
    } else if (
      errorMessage.includes('sasl') ||
      errorMessage.includes('scram-server-final-message') ||
      errorMessage.includes('server signature is missing')
    ) {
      throw new Error(
        `❌ Authentication failed - SASL/SCRAM error (likely wrong password)${context ? ` ${context}` : ''}\n` +
          `   • This usually indicates an incorrect password\n` +
          `   • Please verify your database password in the connection string\n` +
          `   • For Supabase: Check Settings → Database → Connection string`
      );
    } else if (errorMessage.includes('role') && errorMessage.includes('does not exist')) {
      throw new Error(
        `❌ Database user does not exist${context ? ` ${context}` : ''}\n` +
          `   • Please check the username in your connection string\n` +
          `   • Verify the user exists in your database`
      );
    } else if (errorMessage.includes('database') && errorMessage.includes('does not exist')) {
      throw new Error(
        `❌ Database does not exist${context ? ` ${context}` : ''}\n` +
          `   • Please check the database name in your connection string\n` +
          `   • Verify the database exists on your server`
      );
    } else if (errorMessage.includes('ssl') || errorMessage.includes('certificate')) {
      throw new Error(
        `❌ SSL/Certificate error${context ? ` ${context}` : ''}\n` +
          `   • For Supabase: Add '?sslmode=require' to your connection string\n` +
          `   • Or try running with: NODE_TLS_REJECT_UNAUTHORIZED=0\n` +
          `   • Check SSL configuration in your database settings`
      );
    } else if (errorMessage.includes('timeout') || errorCode === 'ETIMEDOUT') {
      throw new Error(
        `❌ Connection timeout${context ? ` ${context}` : ''}\n` +
          `   • Database server may be overloaded\n` +
          `   • Network connectivity issues\n` +
          `   • Firewall blocking the connection`
      );
    } else {
      // Generic database connection error with the original error for debugging
      throw new Error(
        `❌ Database connection failed${context ? ` ${context}` : ''}: ${error.message}\n` +
          `   • Error code: ${errorCode || 'Unknown'}\n` +
          `   • Please check your database connection string and settings\n` +
          `   • Original error: ${error.message}`
      );
    }
  }

  /**
   * Validates a database connection by executing a simple test query
   * @param executeQuery Function that executes a database query
   * @param context Context for error messages
   */
  static async validateConnection(
    executeQuery: () => Promise<any>,
    context = 'during connection validation'
  ): Promise<void> {
    try {
      logger.debug(`[DB ERROR HANDLER] Validating database connection ${context}...`);
      await executeQuery();
      logger.debug(`[DB ERROR HANDLER] ✅ Database connection validated successfully`);
    } catch (error) {
      this.handleDatabaseError(error, context);
    }
  }
}
