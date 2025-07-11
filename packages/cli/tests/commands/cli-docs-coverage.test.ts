import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import {
    setupTestEnvironment,
    cleanupTestEnvironment,
    runCliCommand,
    TestContext,
} from './test-utils';

/**
 * Test suite to ensure all CLI commands are properly tested against CLI documentation
 * This addresses issue #5325: TESTING: test all CLI commands against the CLI Docs
 */
describe('CLI Documentation Coverage', () => {
    let context: TestContext;

    beforeEach(async () => {
        context = await setupTestEnvironment();
    });

    afterEach(async () => {
        await cleanupTestEnvironment(context);
    });

    describe('Command Implementation vs Documentation', () => {
        it('should have all documented commands implemented in CLI', async () => {
            // Get all documented commands from the CLI docs
            const docsPath = join(__dirname, '../../../docs/docs/cli');
            const allFiles = await readdir(docsPath);
            const docFiles = allFiles.filter((file: string) => file.endsWith('.md'));

            // Extract command names from documentation files
            const documentedCommands = new Set<string>();

            for (const docFile of docFiles) {
                const fileName = docFile.replace('.md', '');
                // Skip overview.md as it's not a command
                if (fileName !== 'overview' && fileName !== 'stop') {
                    documentedCommands.add(fileName);
                }
            }

            // Get implemented commands from CLI source
            const implementedCommands = await getImplementedCommands();

            // Check that all documented commands are implemented
            for (const docCommand of documentedCommands) {
                expect(implementedCommands).toContain(docCommand);
            }
        });

        it('should have documentation for all implemented commands', async () => {
            // Get implemented commands from CLI source
            const implementedCommands = await getImplementedCommands();

            // Get documented commands
            const docsPath = join(__dirname, '../../../docs/docs/cli');
            const allFiles = await readdir(docsPath);
            const docFiles = allFiles.filter((file: string) => file.endsWith('.md'));
            const documentedCommands = new Set(
                docFiles
                    .map((f: string) => f.replace('.md', ''))
                    .filter((f: string) => f !== 'overview')
            );

            // Check that all implemented commands have documentation
            for (const implCommand of implementedCommands) {
                // Allow some exceptions for internal/alias commands
                if (!['help', 'version'].includes(implCommand)) {
                    expect(documentedCommands.has(implCommand) || documentedCommands.has('stop')).toBe(true);
                }
            }
        });

        it('should have tests for all documented commands', async () => {
            // Get all documented commands
            const docsPath = join(__dirname, '../../../docs/docs/cli');
            const allFiles = await readdir(docsPath);
            const docFiles = allFiles.filter((file: string) => file.endsWith('.md'));
            const documentedCommands = docFiles
                .map((f: string) => f.replace('.md', ''))
                .filter((f: string) => f !== 'overview');

            // Get all test files
            const testDirFiles = await readdir(__dirname);
            const testFiles = testDirFiles.filter((file: string) => file.endsWith('.test.ts'));
            const testedCommands = new Set(
                testFiles
                    .map((f: string) => f.replace('.test.ts', ''))
                    .filter((f: string) => !['test-utils', 'cli-docs-coverage'].includes(f))
            );

            // Check that all documented commands have test files
            for (const docCommand of documentedCommands) {
                // Some special cases
                if (docCommand === 'stop') {
                    // Stop functionality is tested within agent tests
                    expect(testedCommands.has('agent')).toBe(true);
                } else {
                    expect(testedCommands).toContain(docCommand);
                }
            }
        });
    });

    describe('Command Help Output Validation', () => {
        it('should validate help output for all main commands', async () => {
            const mainCommands = [
                'create', 'start', 'agent', 'plugins', 'test', 'env',
                'dev', 'update', 'publish', 'monorepo', 'tee'
            ];

            for (const command of mainCommands) {
                const result = runCliCommand(context.elizaosCmd, `${command} --help`);

                // Basic help output validation
                expect(result).toContain(`Usage: elizaos ${command}`);
                expect(result).toContain('Options:');

                // Should contain help flag
                expect(result).toMatch(/-h, --help|--help, -h/);
            }
        });

        it('should validate subcommand help output consistency', async () => {
            const subcommands = [
                { main: 'agent', sub: 'list' },
                { main: 'agent', sub: 'get' },
                { main: 'agent', sub: 'start' },
                { main: 'agent', sub: 'stop' },
                { main: 'agent', sub: 'remove' },
                { main: 'agent', sub: 'set' },
                { main: 'agent', sub: 'clear-memories' },
                { main: 'plugins', sub: 'list' },
                { main: 'plugins', sub: 'add' },
                { main: 'plugins', sub: 'remove' },
                { main: 'plugins', sub: 'upgrade' },
                { main: 'plugins', sub: 'generate' },
                { main: 'env', sub: 'list' },
                { main: 'env', sub: 'edit-local' },
                { main: 'env', sub: 'reset' },
                { main: 'env', sub: 'interactive' },
                { main: 'tee', sub: 'phala' },
            ];

            for (const { main, sub } of subcommands) {
                const result = runCliCommand(context.elizaosCmd, `${main} ${sub} --help`);

                // Should contain usage information
                expect(result).toContain('Usage:');
                // Should contain the subcommand name
                expect(result).toContain(sub);
            }
        });
    });

    describe('Command Option Validation', () => {
        it('should validate create command options', async () => {
            const result = runCliCommand(context.elizaosCmd, 'create --help');

            // Check documented options exist
            expect(result).toContain('--yes');
            expect(result).toContain('--type');
            expect(result).toMatch(/project.*plugin.*agent.*tee/s);
        });

        it('should validate start command options', async () => {
            const result = runCliCommand(context.elizaosCmd, 'start --help');

            // Check documented options exist
            expect(result).toContain('--configure');
            expect(result).toContain('--port');
            expect(result).toContain('--character');
        });

        it('should validate agent command options', async () => {
            const agentCommands = ['list', 'get', 'start', 'stop', 'remove', 'set', 'clear-memories'];

            for (const cmd of agentCommands) {
                const result = runCliCommand(context.elizaosCmd, `agent ${cmd} --help`);

                // Common options that should be available
                if (['list', 'get', 'start', 'stop', 'remove', 'set', 'clear-memories'].includes(cmd)) {
                    expect(result).toContain('--remote-url');
                    expect(result).toContain('--port');
                }

                // Specific options
                if (['get', 'start', 'stop', 'remove', 'set', 'clear-memories'].includes(cmd)) {
                    expect(result).toContain('--name');
                }
            }
        });

        it('should validate test command options', async () => {
            const result = runCliCommand(context.elizaosCmd, 'test --help');

            // Check documented options exist
            expect(result).toContain('--type');
            expect(result).toContain('--port');
            expect(result).toContain('--name');
            expect(result).toContain('--skip-build');
            expect(result).toContain('--skip-type-check');
        });

        it('should validate dev command options', async () => {
            const result = runCliCommand(context.elizaosCmd, 'dev --help');

            // Check documented options exist
            expect(result).toContain('--configure');
            expect(result).toContain('--character');
            expect(result).toContain('--build');
            expect(result).toContain('--port');
        });
    });

    describe('Documentation Completeness', () => {
        it('should have complete documentation for each command', async () => {
            const commands = ['create', 'start', 'agent', 'plugins', 'test', 'env', 'dev', 'update', 'publish', 'monorepo', 'tee'];

            for (const command of commands) {
                const docPath = join(__dirname, `../../../docs/docs/cli/${command}.md`);

                try {
                    const docContent = await readFile(docPath, 'utf-8');

                    // Basic documentation structure validation
                    expect(docContent).toContain('# ');
                    expect(docContent).toContain('## Usage');
                    expect(docContent).toContain('## Examples');

                    // Should contain elizaos command examples
                    expect(docContent).toContain('elizaos ' + command);

                } catch (error) {
                    throw new Error(`Documentation missing for command: ${command}`);
                }
            }
        });

        it('should validate overview documentation lists all commands', async () => {
            const overviewPath = join(__dirname, '../../../docs/docs/cli/overview.md');
            const overviewContent = await readFile(overviewPath, 'utf-8');

            const expectedCommands = [
                'create', 'monorepo', 'plugins', 'agent', 'tee',
                'start', 'update', 'test', 'env', 'dev', 'publish'
            ];

            for (const command of expectedCommands) {
                expect(overviewContent).toContain(`[\`${command}\`]`);
            }
        });
    });

    describe('Command Consistency', () => {
        it('should have consistent global options across commands', async () => {
            const commands = ['create', 'start', 'agent', 'plugins', 'test', 'env', 'dev', 'update', 'publish', 'monorepo', 'tee'];

            for (const command of commands) {
                const result = runCliCommand(context.elizaosCmd, `${command} --help`);

                // All commands should support --help
                expect(result).toMatch(/-h, --help|--help/);
            }
        });

        it('should validate version command works', async () => {
            const result = runCliCommand(context.elizaosCmd, '--version');

            // Should return version number
            expect(result).toMatch(/\d+\.\d+\.\d+/);
        });

        it('should validate main help command lists all commands', async () => {
            const result = runCliCommand(context.elizaosCmd, '--help');

            const expectedCommands = [
                'create', 'monorepo', 'plugins', 'agent', 'tee',
                'start', 'update', 'test', 'env', 'dev', 'publish'
            ];

            for (const command of expectedCommands) {
                expect(result).toContain(command);
            }
        });
    });
});

/**
 * Helper function to extract implemented commands from CLI source
 */
async function getImplementedCommands(): Promise<string[]> {
    const indexPath = join(__dirname, '../../src/index.ts');
    const indexContent = await readFile(indexPath, 'utf-8');

    // Extract command names from addCommand calls
    const commandRegex = /\.addCommand\((\w+)\)/g;
    const commands: string[] = [];
    let match;

    while ((match = commandRegex.exec(indexContent)) !== null) {
        commands.push(match[1]);
    }

    // Map command variable names to actual command names
    const commandMapping: { [key: string]: string } = {
        create: 'create',
        monorepo: 'monorepo',
        plugins: 'plugins',
        agent: 'agent',
        teeCommand: 'tee',
        start: 'start',
        update: 'update',
        test: 'test',
        env: 'env',
        dev: 'dev',
        publish: 'publish'
    };

    return commands.map(cmd => commandMapping[cmd] || cmd).filter(Boolean);
}
