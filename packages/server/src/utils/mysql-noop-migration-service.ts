/**
 * No-op Migration Service for MySQL
 * 
 * MySQL plugin does not yet have a full migration service implementation.
 * This class provides a no-op implementation to maintain API compatibility.
 */

import { logger } from '@elizaos/core';
import type { Plugin } from '@elizaos/core';

/**
 * No-op implementation of DatabaseMigrationService for MySQL
 * This allows the server to initialize with MySQL without migration support
 */
export class MySQLNoOpMigrationService {
    /**
     * Initialize with database (no-op for MySQL)
     */
    async initializeWithDatabase(_db: any): Promise<void> {
        logger.debug('[MySQL Migration] initializeWithDatabase (no-op) - MySQL migrations not yet implemented');
    }

    /**
     * Discover and register plugin schemas (no-op for MySQL)
     */
    discoverAndRegisterPluginSchemas(_plugins: Plugin[]): void {
        logger.debug('[MySQL Migration] discoverAndRegisterPluginSchemas (no-op) - MySQL schema registration not yet implemented');
    }

    /**
     * Run all plugin migrations (no-op for MySQL)
     */
    async runAllPluginMigrations(): Promise<void> {
        logger.debug('[MySQL Migration] runAllPluginMigrations (no-op) - MySQL plugin migrations not yet implemented');
    }
}

