/**
 * MySQL Connection String Validator
 * 
 * Validates MySQL connection strings before attempting to use them.
 */

import { logger } from '@elizaos/core';

export interface MySQLValidationResult {
    isValid: boolean;
    error?: string;
    details?: {
        protocol?: string;
        host?: string;
        port?: number;
        database?: string;
        hasCredentials?: boolean;
    };
}

/**
 * Validates a MySQL connection string format
 * 
 * @param mysqlUrl - The MySQL URL to validate
 * @returns Validation result with details
 * 
 * @example
 * validateMySQLUrl('mysql://user:pass@localhost:3306/mydb')
 * // Returns: { isValid: true, details: { protocol: 'mysql', host: 'localhost', ... } }
 */
export function validateMySQLUrl(mysqlUrl: string | undefined): MySQLValidationResult {
    if (!mysqlUrl) {
        return {
            isValid: false,
            error: 'MySQL URL is undefined or empty',
        };
    }

    if (typeof mysqlUrl !== 'string') {
        return {
            isValid: false,
            error: 'MySQL URL must be a string',
        };
    }

    if (mysqlUrl.trim().length === 0) {
        return {
            isValid: false,
            error: 'MySQL URL is empty',
        };
    }

    try {
        // MySQL URLs can use either 'mysql://' or 'mysql2://' protocols
        if (!mysqlUrl.startsWith('mysql://') && !mysqlUrl.startsWith('mysql2://')) {
            return {
                isValid: false,
                error: 'MySQL URL must start with mysql:// or mysql2://',
            };
        }

        // Try to parse as URL
        const url = new URL(mysqlUrl);

        // Validate protocol
        if (!url.protocol.startsWith('mysql')) {
            return {
                isValid: false,
                error: `Invalid protocol: ${url.protocol}. Expected mysql: or mysql2:`,
            };
        }

        // Validate hostname
        if (!url.hostname || url.hostname.length === 0) {
            return {
                isValid: false,
                error: 'MySQL URL must include a hostname',
            };
        }

        // Extract details
        const details = {
            protocol: url.protocol.replace(':', ''),
            host: url.hostname,
            port: url.port ? parseInt(url.port, 10) : 3306,
            database: url.pathname ? url.pathname.substring(1) : undefined,
            hasCredentials: !!(url.username || url.password),
        };

        // Warn if no database is specified
        if (!details.database || details.database.length === 0) {
            logger.warn('[MySQL Validation] No database name specified in connection string');
        }

        // Warn if no credentials
        if (!details.hasCredentials) {
            logger.warn('[MySQL Validation] No credentials specified in connection string');
        }

        return {
            isValid: true,
            details,
        };
    } catch (error) {
        return {
            isValid: false,
            error: `Invalid MySQL URL format: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Validates and logs MySQL connection string
 * Throws an error if validation fails
 * 
 * @param mysqlUrl - The MySQL URL to validate
 * @throws Error if validation fails
 */
export function validateAndLogMySQLUrl(mysqlUrl: string | undefined): void {
    const validation = validateMySQLUrl(mysqlUrl);

    if (!validation.isValid) {
        logger.error(`[MySQL Validation] Invalid MySQL URL: ${validation.error}`);
        throw new Error(`Invalid MySQL URL: ${validation.error}`);
    }

    logger.info('[MySQL Validation] MySQL URL validated successfully');
    logger.debug(
        `[MySQL Validation] Connection details: protocol=${validation.details?.protocol}, ` +
        `host=${validation.details?.host}, port=${validation.details?.port}, ` +
        `database=${validation.details?.database}, hasCredentials=${validation.details?.hasCredentials}`
    );
}

