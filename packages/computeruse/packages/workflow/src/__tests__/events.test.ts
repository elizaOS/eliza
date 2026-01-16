/**
 * Unit tests for the workflow events system
 */

import { emit, createStepEmitter, _getTransportMode } from '../events';

describe('Events Module', () => {
    let stderrSpy: jest.SpyInstance;
    let stderrOutput: string[];

    beforeEach(() => {
        stderrOutput = [];
        // Spy on process.stderr.write to capture output
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
            stderrOutput.push(chunk.toString());
            return true;
        });
        // Ensure we use stderr mode (no pipe configured)
        delete process.env.MCP_EVENT_PIPE;
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    describe('emit.progress', () => {
        it('should emit progress with all fields', () => {
            emit.progress(5, 10, 'Processing...');

            expect(stderrOutput.length).toBe(1);
            const event = JSON.parse(stderrOutput[0]);

            expect(event.__mcp_event__).toBe(true);
            expect(event.type).toBe('progress');
            expect(event.current).toBe(5);
            expect(event.total).toBe(10);
            expect(event.message).toBe('Processing...');
            expect(event.timestamp).toBeDefined();
        });

        it('should emit progress without optional fields', () => {
            emit.progress(3);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.current).toBe(3);
            expect(event.total).toBeUndefined();
            expect(event.message).toBeUndefined();
        });

        it('should emit progress with only current and total', () => {
            emit.progress(1, 5);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.current).toBe(1);
            expect(event.total).toBe(5);
            expect(event.message).toBeUndefined();
        });

        it('should handle fractional progress values', () => {
            emit.progress(2.5, 4);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.current).toBe(2.5);
        });
    });

    describe('emit.stepStarted', () => {
        it('should emit step started with all fields', () => {
            emit.stepStarted('login', 'Login Step', 0, 3);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.__mcp_event__).toBe(true);
            expect(event.type).toBe('step_started');
            expect(event.stepId).toBe('login');
            expect(event.stepName).toBe('Login Step');
            expect(event.stepIndex).toBe(0);
            expect(event.totalSteps).toBe(3);
        });

        it('should emit step started without optional fields', () => {
            emit.stepStarted('setup', 'Setup');

            const event = JSON.parse(stderrOutput[0]);

            expect(event.stepId).toBe('setup');
            expect(event.stepName).toBe('Setup');
            expect(event.stepIndex).toBeUndefined();
            expect(event.totalSteps).toBeUndefined();
        });
    });

    describe('emit.stepCompleted', () => {
        it('should emit step completed with duration', () => {
            emit.stepCompleted('login', 'Login Step', 1500, 0, 3);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('step_completed');
            expect(event.stepId).toBe('login');
            expect(event.stepName).toBe('Login Step');
            expect(event.duration).toBe(1500);
            expect(event.stepIndex).toBe(0);
            expect(event.totalSteps).toBe(3);
        });
    });

    describe('emit.stepFailed', () => {
        it('should emit step failed with error', () => {
            emit.stepFailed('login', 'Login Step', 'Element not found', 500);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('step_failed');
            expect(event.stepId).toBe('login');
            expect(event.stepName).toBe('Login Step');
            expect(event.error).toBe('Element not found');
            expect(event.duration).toBe(500);
        });
    });

    describe('emit.screenshot', () => {
        it('should emit screenshot with path', () => {
            emit.screenshot('/tmp/screenshot.png', 'Login screen');

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('screenshot');
            expect(event.path).toBe('/tmp/screenshot.png');
            expect(event.annotation).toBe('Login screen');
            expect(event.base64).toBeUndefined();
        });

        it('should emit screenshot with base64 data', () => {
            const base64Data = 'data:image/png;base64,' + 'A'.repeat(600);
            emit.screenshot(base64Data, 'Captured element', 'role:Button');

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('screenshot');
            expect(event.base64).toBe(base64Data);
            expect(event.annotation).toBe('Captured element');
            expect(event.element).toBe('role:Button');
            expect(event.path).toBeUndefined();
        });

        it('should detect base64 by length', () => {
            const longData = 'A'.repeat(501);
            emit.screenshot(longData);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.base64).toBe(longData);
            expect(event.path).toBeUndefined();
        });

        it('should treat short strings as paths', () => {
            emit.screenshot('./short.png');

            const event = JSON.parse(stderrOutput[0]);
            expect(event.path).toBe('./short.png');
        });
    });

    describe('emit.data', () => {
        it('should emit data with string value', () => {
            emit.data('username', 'john@example.com');

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('data');
            expect(event.key).toBe('username');
            expect(event.value).toBe('john@example.com');
        });

        it('should emit data with number value', () => {
            emit.data('count', 42);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.value).toBe(42);
        });

        it('should emit data with object value', () => {
            emit.data('config', { timeout: 5000, retries: 3 });

            const event = JSON.parse(stderrOutput[0]);
            expect(event.value).toEqual({ timeout: 5000, retries: 3 });
        });

        it('should emit data with array value', () => {
            emit.data('items', ['a', 'b', 'c']);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.value).toEqual(['a', 'b', 'c']);
        });

        it('should emit data with null value', () => {
            emit.data('empty', null);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.value).toBeNull();
        });

        it('should emit data with boolean value', () => {
            emit.data('enabled', true);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.value).toBe(true);
        });
    });

    describe('emit.log', () => {
        it('should emit log with info level', () => {
            emit.log('info', 'Processing started');

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('log');
            expect(event.level).toBe('info');
            expect(event.message).toBe('Processing started');
            expect(event.data).toBeUndefined();
        });

        it('should emit log with error level and data', () => {
            emit.log('error', 'Failed to click', { selector: 'role:Button', timeout: 5000 });

            const event = JSON.parse(stderrOutput[0]);

            expect(event.level).toBe('error');
            expect(event.message).toBe('Failed to click');
            expect(event.data).toEqual({ selector: 'role:Button', timeout: 5000 });
        });

        it('should emit log with debug level', () => {
            emit.log('debug', 'Variable state', { x: 1, y: 2 });

            const event = JSON.parse(stderrOutput[0]);
            expect(event.level).toBe('debug');
        });

        it('should emit log with warn level', () => {
            emit.log('warn', 'Deprecated API used');

            const event = JSON.parse(stderrOutput[0]);
            expect(event.level).toBe('warn');
        });
    });

    describe('emit.raw', () => {
        it('should emit raw event', () => {
            emit.raw({ type: 'progress', current: 1, total: 5 } as Omit<import('../events').ProgressEvent, '__mcp_event__' | 'timestamp'>);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.__mcp_event__).toBe(true);
            expect(event.type).toBe('progress');
            expect(event.current).toBe(1);
            expect(event.timestamp).toBeDefined();
        });
    });

    describe('createStepEmitter', () => {
        it('should prefix messages with step name', () => {
            const stepEmit = createStepEmitter('process', 'Process Items', 1, 3);

            stepEmit.progress(5, 10, 'Working...');

            const event = JSON.parse(stderrOutput[0]);
            expect(event.message).toBe('[Process Items] Working...');
        });

        it('should use default message format when no message provided', () => {
            const stepEmit = createStepEmitter('process', 'Process Items', 1, 3);

            stepEmit.progress(2, 5);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.message).toBe('[Process Items] Step 2/5');
        });

        it('should namespace data keys with step id', () => {
            const stepEmit = createStepEmitter('download', 'Download Files');

            stepEmit.data('fileCount', 10);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.key).toBe('download.fileCount');
        });

        it('should emit started event', () => {
            const stepEmit = createStepEmitter('login', 'Login', 0, 3);

            stepEmit.started();

            const event = JSON.parse(stderrOutput[0]);
            expect(event.type).toBe('step_started');
            expect(event.stepId).toBe('login');
            expect(event.stepName).toBe('Login');
            expect(event.stepIndex).toBe(0);
            expect(event.totalSteps).toBe(3);
        });

        it('should emit completed event', () => {
            const stepEmit = createStepEmitter('login', 'Login', 0, 3);

            stepEmit.completed(1500);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.type).toBe('step_completed');
            expect(event.duration).toBe(1500);
        });

        it('should emit failed event', () => {
            const stepEmit = createStepEmitter('login', 'Login', 0, 3);

            stepEmit.failed('Timeout', 500);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.type).toBe('step_failed');
            expect(event.error).toBe('Timeout');
            expect(event.duration).toBe(500);
        });

        it('should prefix log messages', () => {
            const stepEmit = createStepEmitter('upload', 'Upload');

            stepEmit.log('info', 'File uploaded');

            const event = JSON.parse(stderrOutput[0]);
            expect(event.message).toBe('[Upload] File uploaded');
        });

        it('should prefix screenshot annotations', () => {
            const stepEmit = createStepEmitter('verify', 'Verify');

            stepEmit.screenshot('/tmp/test.png', 'State check');

            const event = JSON.parse(stderrOutput[0]);
            expect(event.annotation).toBe('[Verify] State check');
        });

        it('should prefix status messages with step name', () => {
            const stepEmit = createStepEmitter('upload', 'Upload');

            stepEmit.status('Uploading files...', 5000);

            const event = JSON.parse(stderrOutput[0]);
            expect(event.type).toBe('status');
            expect(event.message).toBe('[Upload] Uploading files...');
            expect(event.duration).toBe(5000);
        });
    });

    describe('event format', () => {
        it('should always include __mcp_event__ flag', () => {
            emit.progress(1);
            emit.data('key', 'value');
            emit.log('info', 'test');

            stderrOutput.forEach((output) => {
                const event = JSON.parse(output);
                expect(event.__mcp_event__).toBe(true);
            });
        });

        it('should always include timestamp', () => {
            const before = new Date().toISOString();
            emit.progress(1);
            const after = new Date().toISOString();

            const event = JSON.parse(stderrOutput[0]);
            expect(event.timestamp).toBeDefined();
            expect(event.timestamp >= before).toBe(true);
            expect(event.timestamp <= after).toBe(true);
        });

        it('should emit newline-delimited JSON', () => {
            emit.progress(1);

            expect(stderrOutput[0].endsWith('\n')).toBe(true);
        });

        it('should emit valid JSON', () => {
            emit.data('complex', {
                nested: { deeply: { value: 123 } },
                array: [1, 2, { three: 3 }],
                special: 'quotes "here" and \\ backslash',
            });

            expect(() => JSON.parse(stderrOutput[0])).not.toThrow();
        });
    });


    describe('emit.status', () => {
        it('should emit status with text only', () => {
            emit.status('Loading...');

            expect(stderrOutput.length).toBe(1);
            const event = JSON.parse(stderrOutput[0]);

            expect(event.__mcp_event__).toBe(true);
            expect(event.type).toBe('status');
            expect(event.message).toBe('Loading...');
            expect(event.duration).toBeUndefined();
            expect(event.timestamp).toBeDefined();
        });

        it('should emit status with text and duration', () => {
            emit.status('Processing complete!', 3000);

            const event = JSON.parse(stderrOutput[0]);

            expect(event.type).toBe('status');
            expect(event.message).toBe('Processing complete!');
            expect(event.duration).toBe(3000);
        });

        it('should handle empty status text', () => {
            emit.status('');

            const event = JSON.parse(stderrOutput[0]);
            expect(event.message).toBe('');
        });
    });

    describe('_getTransportMode', () => {
        it('should return stderr when no pipe configured', () => {
            delete process.env.MCP_EVENT_PIPE;
            expect(_getTransportMode()).toBe('stderr');
        });

        it('should return pipe when MCP_EVENT_PIPE is set', () => {
            process.env.MCP_EVENT_PIPE = '\\\\.\\pipe\\test-pipe';
            expect(_getTransportMode()).toBe('pipe');
            delete process.env.MCP_EVENT_PIPE;
        });
    });
});

describe('Events Integration', () => {
    it('should handle rapid event emission', () => {
        const stderrOutput: string[] = [];
        const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
            stderrOutput.push(chunk.toString());
            return true;
        });

        // Emit many events rapidly
        for (let i = 0; i < 100; i++) {
            emit.progress(i, 100, `Step ${i}`);
        }

        expect(stderrOutput.length).toBe(100);

        // All should be valid JSON
        stderrOutput.forEach((output, i) => {
            const event = JSON.parse(output);
            expect(event.current).toBe(i);
        });

        spy.mockRestore();
    });

    it('should handle unicode in messages', () => {
        const stderrOutput: string[] = [];
        const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
            stderrOutput.push(chunk.toString());
            return true;
        });

        emit.log('info', '日本語テスト 🚀 émojis');
        emit.data('unicode', { greeting: '你好世界' });

        const log = JSON.parse(stderrOutput[0]);
        expect(log.message).toBe('日本語テスト 🚀 émojis');

        const data = JSON.parse(stderrOutput[1]);
        expect(data.value.greeting).toBe('你好世界');

        spy.mockRestore();
    });
});
