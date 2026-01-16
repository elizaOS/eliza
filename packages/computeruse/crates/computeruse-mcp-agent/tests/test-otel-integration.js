/**
 * Test script to verify OpenTelemetry integration with MCP server
 * This tests that workflow execution events are properly traced
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { spawn } = require('child_process');
const path = require('path');

// Configuration
const MCP_SERVER_PATH = path.join(__dirname, 'computeruse-mcp-agent');
const TEST_WORKFLOW = path.join(__dirname, 'test-workflow.yml');

// Simple OTLP collector mock to capture traces
class SimpleOTLPCollector {
    constructor(port = 4318) {
        this.port = port;
        this.traces = [];
        this.server = null;
    }

    async start() {
        const http = require('http');
        
        this.server = http.createServer((req, res) => {
            if (req.url === '/v1/traces' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const trace = JSON.parse(body);
                        this.traces.push(trace);
                        console.log('[OTLP Collector] Received trace:', JSON.stringify(trace, null, 2));
                    } catch (e) {
                        console.error('[OTLP Collector] Failed to parse trace:', e);
                    }
                    res.writeHead(200);
                    res.end('OK');
                });
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        return new Promise((resolve) => {
            this.server.listen(this.port, () => {
                console.log(`[OTLP Collector] Listening on http://localhost:${this.port}`);
                resolve();
            });
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
    }

    getTraces() {
        return this.traces;
    }
}

async function testOpenTelemetryIntegration() {
    console.log('='.repeat(60));
    console.log('OpenTelemetry Integration Test for MCP Server');
    console.log('='.repeat(60));

    // Start OTLP collector
    const collector = new SimpleOTLPCollector();
    await collector.start();

    try {
        // Build the MCP server with telemetry feature
        console.log('\n1. Building MCP server with telemetry feature...');
        const buildProcess = spawn('cargo', ['build', '--features', 'telemetry'], {
            cwd: MCP_SERVER_PATH,
            shell: true
        });

        await new Promise((resolve, reject) => {
            buildProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('   ✓ Build successful');
                    resolve();
                } else {
                    reject(new Error(`Build failed with code ${code}`));
                }
            });
        });

        // Start MCP server with telemetry enabled
        console.log('\n2. Starting MCP server with telemetry...');
        const transport = new StdioClientTransport({
            command: 'cargo',
            args: ['run', '--features', 'telemetry', '--bin', 'computeruse-mcp-agent'],
            cwd: MCP_SERVER_PATH,
            env: {
                ...process.env,
                OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
                RUST_LOG: 'info'
            }
        });

        const client = new Client({
            name: 'otel-test-client',
            version: '1.0.0',
        }, {
            capabilities: {}
        });

        await client.connect(transport);
        console.log('   ✓ Connected to MCP server');

        // List available tools
        console.log('\n3. Listing available tools...');
        const tools = await client.listTools();
        console.log(`   ✓ Found ${tools.tools.length} tools`);
        
        const hasExecuteSequence = tools.tools.some(t => t.name === 'execute_sequence');
        const hasExecuteWorkflow = tools.tools.some(t => t.name === 'execute_workflow');
        console.log(`   - execute_sequence: ${hasExecuteSequence ? '✓' : '✗'}`);
        console.log(`   - execute_workflow: ${hasExecuteWorkflow ? '✓' : '✗'}`);

        // Execute a simple sequence to generate traces
        console.log('\n4. Executing test sequence...');
        const sequenceResult = await client.callTool({
            name: 'execute_sequence',
            arguments: {
                steps: [
                    {
                        tool_name: 'screenshot',
                        arguments: {},
                        id: 'screenshot_001'
                    },
                    {
                        tool_name: 'wait',
                        arguments: { delay_ms: 100 },
                        id: 'wait_001'
                    }
                ]
            }
        });

        console.log('   ✓ Sequence executed');
        console.log('   Result:', JSON.stringify(sequenceResult, null, 2).substring(0, 200) + '...');

        // Wait for traces to be exported
        console.log('\n5. Waiting for traces to be exported...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check collected traces
        const traces = collector.getTraces();
        console.log(`\n6. Collected ${traces.length} trace batches`);
        
        if (traces.length > 0) {
            console.log('   ✓ OpenTelemetry integration working!');
            
            // Analyze trace content
            traces.forEach((trace, i) => {
                console.log(`\n   Trace batch ${i + 1}:`);
                if (trace.resourceSpans) {
                    trace.resourceSpans.forEach(rs => {
                        if (rs.scopeSpans) {
                            rs.scopeSpans.forEach(ss => {
                                if (ss.spans) {
                                    ss.spans.forEach(span => {
                                        console.log(`     - Span: ${span.name || 'unnamed'}`);
                                        if (span.attributes) {
                                            span.attributes.forEach(attr => {
                                                console.log(`       ${attr.key}: ${JSON.stringify(attr.value)}`);
                                            });
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        } else {
            console.log('   ⚠ No traces collected. Possible issues:');
            console.log('     - OTEL_SDK_DISABLED might be set');
            console.log('     - Telemetry feature might not be properly enabled');
            console.log('     - OTLP endpoint might be misconfigured');
        }

        // Clean up
        console.log('\n7. Cleaning up...');
        await client.close();
        console.log('   ✓ Disconnected from MCP server');

    } catch (error) {
        console.error('\n✗ Test failed:', error.message);
        console.error(error.stack);
    } finally {
        collector.stop();
        console.log('   ✓ OTLP collector stopped');
    }

    console.log('\n' + '='.repeat(60));
    console.log('Test completed');
    console.log('='.repeat(60));
}

// Run the test
testOpenTelemetryIntegration().catch(console.error);