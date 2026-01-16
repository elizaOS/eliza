/**
 * Test HTTP-based event capture for workflow execution
 * This simulates what the previous SSE event bus was doing
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const MCP_SERVER_PATH = path.join(__dirname, 'computeruse-mcp-agent');
const MCP_SERVER_PORT = 3333;

// Mock OTLP collector to receive telemetry data
function startOTLPCollector(port = 4318) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/v1/traces' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    console.log('[OTLP] Received trace data');
                    console.log('[OTLP] Headers:', req.headers);
                    try {
                        const data = JSON.parse(body);
                        console.log('[OTLP] Trace content:', JSON.stringify(data, null, 2));
                    } catch (e) {
                        console.log('[OTLP] Raw body:', body);
                    }
                    res.writeHead(200);
                    res.end('OK');
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        server.listen(port, () => {
            console.log(`[OTLP Collector] Started on port ${port}`);
            resolve(server);
        });
    });
}

// Start MCP server with telemetry
async function startMCPServer() {
    console.log('[MCP Server] Starting with telemetry enabled...');
    
    const server = spawn('cargo', [
        'run',
        '--features', 'telemetry',
        '--bin', 'computeruse-mcp-agent',
        '--',
        '--transport', 'http',
        '--port', MCP_SERVER_PORT.toString()
    ], {
        cwd: MCP_SERVER_PATH,
        env: {
            ...process.env,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
            RUST_LOG: 'info,computeruse_mcp_agent=debug'
        },
        shell: true
    });

    server.stdout.on('data', (data) => {
        console.log(`[MCP Server stdout] ${data}`);
    });

    server.stderr.on('data', (data) => {
        console.log(`[MCP Server stderr] ${data}`);
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return server;
}

// Execute workflow via HTTP
async function executeWorkflow() {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                name: "execute_sequence",
                arguments: {
                    steps: [
                        {
                            tool_name: "screenshot",
                            id: "step_1"
                        },
                        {
                            tool_name: "wait",
                            arguments: { delay_ms: 100 },
                            id: "step_2"
                        }
                    ]
                }
            },
            id: "test_" + Date.now()
        });

        const options = {
            hostname: 'localhost',
            port: MCP_SERVER_PORT,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        console.log('[HTTP Client] Sending workflow execution request...');
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log('[HTTP Client] Response status:', res.statusCode);
                console.log('[HTTP Client] Response:', data);
                resolve(data);
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Main test
async function runTest() {
    console.log('='.repeat(60));
    console.log('Testing OpenTelemetry Event Capture');
    console.log('='.repeat(60));
    
    let otlpServer = null;
    let mcpServer = null;
    
    try {
        // 1. Start OTLP collector
        otlpServer = await startOTLPCollector();
        
        // 2. Build MCP server with telemetry
        console.log('\n[Build] Building MCP server with telemetry feature...');
        const buildProcess = spawn('cargo', ['build', '--features', 'telemetry'], {
            cwd: MCP_SERVER_PATH,
            shell: true,
            stdio: 'inherit'
        });
        
        await new Promise((resolve, reject) => {
            buildProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('[Build] Success');
                    resolve();
                } else {
                    reject(new Error(`Build failed with code ${code}`));
                }
            });
        });
        
        // 3. Start MCP server
        mcpServer = await startMCPServer();
        
        // 4. Execute workflow
        console.log('\n[Test] Executing workflow...');
        await executeWorkflow();
        
        // 5. Wait for telemetry to be sent
        console.log('\n[Test] Waiting for telemetry data...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('\n[Test] Test completed!');
        console.log('\nSummary:');
        console.log('- MCP server started with telemetry feature');
        console.log('- Workflow executed via HTTP');
        console.log('- Check OTLP collector output above for traces');
        
    } catch (error) {
        console.error('\n[Error]', error);
    } finally {
        // Cleanup
        if (mcpServer) {
            console.log('\n[Cleanup] Stopping MCP server...');
            mcpServer.kill();
        }
        if (otlpServer) {
            console.log('[Cleanup] Stopping OTLP collector...');
            otlpServer.close();
        }
    }
}

// Run the test
runTest().catch(console.error);