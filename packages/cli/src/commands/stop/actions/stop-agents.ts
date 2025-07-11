import { StopOptions } from '../types';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Simple logger fallback if @elizaos/core is not available
const logger = {
    info: (msg: string, ...args: any[]) => console.log(`ℹ️  ${msg}`, ...args),
    warn: (msg: string, ...args: any[]) => console.warn(`⚠️  ${msg}`, ...args),
    error: (msg: string, ...args: any[]) => console.error(`❌ ${msg}`, ...args),
    debug: (msg: string, ...args: any[]) => console.debug(`🐛 ${msg}`, ...args),
};

export async function stopAgents(options: StopOptions): Promise<void> {
    if (!options.quiet) {
        logger.info('🛑 Stopping ElizaOS agents...');
    }

    try {
        const processes = findElizaProcesses();

        if (processes.length === 0) {
            if (!options.quiet) {
                logger.info('✅ No ElizaOS agents are currently running');
            }
            process.exit(2); // Exit code 2: No agents running
        }

        let processesToStop = processes;

        // Filter by specific agent name if provided
        if (options.agent) {
            processesToStop = processes.filter(p =>
                p.command.includes(options.agent!) || p.command.includes(`--character`) && p.command.includes(options.agent!)
            );

            if (processesToStop.length === 0) {
                if (!options.quiet) {
                    logger.warn(`⚠️  No agent named '${options.agent}' found running`);
                }
                process.exit(2);
            }
        }

        if (!options.quiet) {
            logger.info(`📋 Found ${processesToStop.length} ElizaOS process(es) to stop`);
        }

        let stopSuccess = 0;
        let stopFailed = 0;

        for (const proc of processesToStop) {
            try {
                if (!options.quiet) {
                    logger.info(`🔄 Stopping process ${proc.pid}...`);
                }

                if (options.force) {
                    // Force kill (SIGKILL)
                    if (process.platform === 'win32') {
                        execSync(`taskkill /F /PID ${proc.pid}`, { stdio: 'ignore' });
                    } else {
                        execSync(`kill -9 ${proc.pid}`, { stdio: 'ignore' });
                    }
                } else {
                    // Graceful shutdown (SIGTERM)
                    if (process.platform === 'win32') {
                        execSync(`taskkill /PID ${proc.pid}`, { stdio: 'ignore' });
                    } else {
                        execSync(`kill -TERM ${proc.pid}`, { stdio: 'ignore' });
                    }

                    // Wait for graceful shutdown
                    await waitForProcessToStop(proc.pid, 10000); // 10 second timeout
                }

                stopSuccess++;
                if (!options.quiet) {
                    logger.info(`✅ Process ${proc.pid} stopped successfully`);
                }
            } catch (error) {
                stopFailed++;
                if (!options.quiet) {
                    logger.error(`❌ Failed to stop process ${proc.pid}:`, error);
                }
            }
        }

        // Clean up lock files and temp files
        await cleanupAfterStop(options.quiet || false);

        if (!options.quiet) {
            if (stopSuccess > 0) {
                logger.info(`✅ Successfully stopped ${stopSuccess} process(es)`);
            }
            if (stopFailed > 0) {
                logger.warn(`⚠️  Failed to stop ${stopFailed} process(es)`);
            }
        }

        // Exit with appropriate code
        if (stopFailed > 0) {
            process.exit(3); // Partial shutdown
        } else {
            process.exit(0); // Successful shutdown
        }
    } catch (error) {
        logger.error('❌ Error stopping agents:', error);
        process.exit(1);
    }
}

interface ElizaProcess {
    pid: number;
    command: string;
}

function findElizaProcesses(): ElizaProcess[] {
    const processes: ElizaProcess[] = [];

    try {
        let psOutput: string;

        if (process.platform === 'win32') {
            // Windows: use wmic or tasklist
            try {
                psOutput = execSync('wmic process where "name like \'%node%\' or name like \'%bun%\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf8' });
            } catch {
                psOutput = execSync('tasklist /FO CSV /V', { encoding: 'utf8' });
            }
        } else {
            // Unix-like: use ps
            psOutput = execSync('ps aux', { encoding: 'utf8' });
        }

        const lines = psOutput.split('\n');

        for (const line of lines) {
            // Look for ElizaOS related processes
            if (line.includes('elizaos') ||
                line.includes('eliza') ||
                line.includes('@elizaos') ||
                (line.includes('node') && line.includes('start')) ||
                (line.includes('bun') && line.includes('start'))) {

                // Skip grep processes and the current stop process
                if (line.includes('grep') || line.includes('stop')) {
                    continue;
                }

                const pid = extractPid(line, process.platform);
                if (pid) {
                    processes.push({
                        pid,
                        command: line.trim()
                    });
                }
            }
        }
    } catch (error) {
        logger.debug('Error finding processes:', error);
    }

    return processes;
}

function extractPid(line: string, platform: string): number | null {
    try {
        if (platform === 'win32') {
            // Windows CSV format or tasklist format
            const parts = line.split(',');
            if (parts.length > 1) {
                const pidStr = parts[1]?.replace(/"/g, '').trim();
                const pid = parseInt(pidStr);
                return isNaN(pid) ? null : pid;
            }
        } else {
            // Unix-like ps aux format
            const parts = line.trim().split(/\s+/);
            if (parts.length > 1) {
                const pid = parseInt(parts[1]);
                return isNaN(pid) ? null : pid;
            }
        }
    } catch {
        // Ignore parsing errors
    }
    return null;
}

async function waitForProcessToStop(pid: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            if (process.platform === 'win32') {
                execSync(`tasklist /FI "PID eq ${pid}"`, { stdio: 'ignore' });
            } else {
                execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
            }
            // Process still exists, wait a bit
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch {
            // Process no longer exists
            return;
        }
    }

    // Timeout reached, process might still be running
    throw new Error(`Process ${pid} did not stop within ${timeoutMs}ms`);
}

async function cleanupAfterStop(quiet: boolean): Promise<void> {
    try {
        const homeDir = os.homedir();
        const elizaDir = path.join(homeDir, '.elizaos');

        // Remove lock files
        try {
            if (fs.existsSync(elizaDir)) {
                const files = fs.readdirSync(elizaDir);
                for (const file of files) {
                    if (file.endsWith('.lock')) {
                        const lockFile = path.join(elizaDir, file);
                        fs.unlinkSync(lockFile);
                        if (!quiet) {
                            logger.debug(`🧹 Removed lock file: ${lockFile}`);
                        }
                    }
                }
            }
        } catch (error) {
            if (!quiet) {
                logger.debug('Could not clean lock files:', error);
            }
        }

        // Clear temp files
        const tmpDir = path.join(elizaDir, 'tmp');
        try {
            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                if (!quiet) {
                    logger.debug(`🧹 Cleared temp directory: ${tmpDir}`);
                }
            }
        } catch (error) {
            if (!quiet) {
                logger.debug('Could not clean temp directory:', error);
            }
        }
    } catch (error) {
        if (!quiet) {
            logger.debug('Cleanup error:', error);
        }
    }
}
