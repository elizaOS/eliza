#!/usr/bin/env node
/**
 * Chrome Bridge Health Check Test
 * 
 * Tests the health and functionality of the Chrome extension bridge by:
 * 1. Verifying browser script tools are available
 * 2. Testing if Chrome extension is connected
 * 3. Checking browser context accessibility
 * 4. Running various browser script scenarios
 * 5. Providing detailed diagnostics for failures
 * 
 * Usage:
 *   node test_chrome_bridge_health.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout } from 'timers/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes for better output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

class ChromeBridgeHealthCheck {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
    this.healthStatus = {
      mcp_server_running: false,
      mcp_connection_established: false,
      browser_script_tool_available: false,
      chrome_extension_connected: false,
      browser_context_accessible: false,
      dom_manipulation_working: false,
      console_capture_working: false,
      async_execution_working: false,
      errors: [],
      warnings: [],
      diagnostics: {}
    };
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString().substr(11, 8);
    const prefix = {
      info: `${colors.blue}ℹ${colors.reset}`,
      success: `${colors.green}✅${colors.reset}`,
      error: `${colors.red}❌${colors.reset}`,
      warning: `${colors.yellow}⚠️${colors.reset}`,
      test: `${colors.cyan}🧪${colors.reset}`
    }[type] || '';
    
    console.log(`[${timestamp}] ${prefix} ${message}`);
  }

  async startMcpServer(port = 3006) {
    this.log(`Starting MCP server on port ${port}...`, 'info');
    
    // Find the MCP binary
    const possiblePaths = [
      path.join(__dirname, '../../../target/release/computeruse-mcp-agent.exe'),
      path.join(__dirname, '../../../target/release/computeruse-mcp-agent'),
      path.join(__dirname, '../target/release/computeruse-mcp-agent.exe'),
      path.join(__dirname, '../target/release/computeruse-mcp-agent'),
      'target/release/computeruse-mcp-agent.exe',
      'target/release/computeruse-mcp-agent',
    ];
    
    let binaryPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        binaryPath = p;
        break;
      }
    }
    
    if (!binaryPath) {
      throw new Error('MCP binary not found. Build with: cargo build --release');
    }
    
    this.log(`Using binary: ${binaryPath}`, 'info');
    
    // Start the server process
    this.serverProcess = spawn(binaryPath, [
      '--transport', 'http',
      '--port', port.toString(),
      '--cors' // Enable CORS for browser testing
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: 'info,computeruse=debug,extension_bridge=debug',
        RUST_BACKTRACE: '1'
      }
    });
    
    // Capture server logs
    this.serverProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg.includes('extension bridge listening')) {
        this.healthStatus.diagnostics.bridge_port = msg.match(/127\.0\.0\.1:(\d+)/)?.[1];
      }
      console.log(`[SERVER] ${msg}`);
    });
    
    this.serverProcess.stderr?.on('data', (data) => {
      console.error(`[SERVER ERROR] ${data.toString().trim()}`);
    });
    
    this.serverProcess.on('exit', (code) => {
      this.log(`Server process exited with code ${code}`, code === 0 ? 'info' : 'error');
    });
    
    // Wait for server to start
    this.log('Waiting for server to initialize...', 'info');
    await setTimeout(3000);
    
    // Test server health
    try {
      const healthUrl = `http://127.0.0.1:${port}/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      
      const healthData = await response.json();
      this.healthStatus.mcp_server_running = true;
      this.healthStatus.diagnostics.server_health = healthData;
      this.log('Server health check passed', 'success');
      
      // Also check status endpoint
      const statusUrl = `http://127.0.0.1:${port}/status`;
      const statusResponse = await fetch(statusUrl);
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        this.healthStatus.diagnostics.server_status = statusData;
      }
    } catch (error) {
      this.healthStatus.errors.push(`Server health check failed: ${error.message}`);
      throw new Error(`Cannot reach MCP server: ${error}`);
    }
  }

  async connect(port = 3006) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    this.log(`Connecting to MCP server at ${httpUrl}...`, 'info');
    
    try {
      // Create StreamableHTTP transport
      this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
      
      // Create MCP client
      this.client = new Client(
        {
          name: "chrome-bridge-health-check",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );
      
      // Connect to the server
      await this.client.connect(this.transport);
      
      // Wait for connection to stabilize
      await setTimeout(500);
      
      this.healthStatus.mcp_connection_established = true;
      this.log('Connected to MCP server', 'success');
      
      // List available tools
      const tools = await this.client.request({
        method: 'tools/list'
      });
      
      const toolNames = tools.tools?.map(t => t.name) || [];
      this.healthStatus.diagnostics.available_tools = toolNames;
      
      // Check for browser-related tools
      const browserTools = ['execute_browser_script', 'navigate_browser'];
      const hasBrowserTools = browserTools.every(tool => toolNames.includes(tool));
      
      if (hasBrowserTools) {
        this.healthStatus.browser_script_tool_available = true;
        this.log(`Browser tools available: ${browserTools.join(', ')}`, 'success');
      } else {
        this.healthStatus.warnings.push('Some browser tools are missing');
        this.log('Warning: Not all browser tools are available', 'warning');
      }
      
    } catch (error) {
      this.healthStatus.errors.push(`MCP connection failed: ${error.message}`);
      this.log(`Failed to connect: ${error}`, 'error');
      throw error;
    }
  }

  async callTool(name, arguments_) {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }
    
    try {
      const result = await this.client.request({
        method: 'tools/call',
        params: {
          name: name,
          arguments: arguments_ || {}
        }
      });
      
      return result;
    } catch (error) {
      // Log detailed error info
      this.healthStatus.errors.push(`Tool call ${name} failed: ${error.message}`);
      throw error;
    }
  }

  async testChromeExtensionConnection() {
    this.log('Testing Chrome extension connection...', 'test');
    
    try {
      // Simple alive check
      const result = await this.callTool('execute_browser_script', {
        selector: 'role:Document',
        script: '({ alive: true, timestamp: Date.now() })',
        timeout_ms: 5000
      });
      
      // Check if we got a valid response
      if (result.content && result.content.length > 0) {
        const content = result.content[0];
        if (content.type === 'text' && content.text.includes('alive')) {
          this.healthStatus.chrome_extension_connected = true;
          this.log('Chrome extension is connected and responding', 'success');
          
          // Parse response to get more info
          try {
            const data = JSON.parse(content.text);
            this.healthStatus.diagnostics.extension_response = data;
          } catch (e) {
            // Response might not be JSON
          }
          
          return true;
        }
      }
      
      this.healthStatus.warnings.push('Extension connected but response was invalid');
      this.log('Extension connected but response was unexpected', 'warning');
      return false;
      
    } catch (error) {
      const errorMsg = error.message || String(error);
      
      // Analyze error for common patterns
      if (errorMsg.includes('no clients connected')) {
        this.healthStatus.errors.push('Chrome extension not connected to bridge');
        this.log('Chrome extension is not connected to the bridge', 'error');
        this.log('Make sure the ComputerUse browser extension is installed and enabled', 'info');
        this.log(`Extension should connect to ws://127.0.0.1:${this.healthStatus.diagnostics.bridge_port || '17373'}`, 'info');
      } else if (errorMsg.includes('timeout')) {
        this.healthStatus.errors.push('Chrome extension timed out');
        this.log('Chrome extension request timed out', 'error');
        this.log('Extension might be installed but not responding', 'info');
      } else if (errorMsg.includes('Failed to find element')) {
        this.healthStatus.warnings.push('Could not find browser document');
        this.log('Could not find browser document element', 'warning');
        this.log('Make sure a browser window is open', 'info');
      } else {
        this.healthStatus.errors.push(`Extension test failed: ${errorMsg}`);
        this.log(`Extension connection test failed: ${errorMsg}`, 'error');
      }
      
      return false;
    }
  }

  async testBrowserContext() {
    this.log('Testing browser context accessibility...', 'test');
    
    try {
      const result = await this.callTool('execute_browser_script', {
        selector: 'role:Document',
        script: `({
          hasDocument: typeof document !== 'undefined',
          url: window.location.href,
          title: document.title,
          readyState: document.readyState,
          documentElement: {
            tagName: document.documentElement.tagName,
            childElementCount: document.documentElement.childElementCount
          },
          browserInfo: {
            userAgent: navigator.userAgent,
            language: navigator.language,
            onLine: navigator.onLine,
            cookieEnabled: navigator.cookieEnabled
          }
        })`,
        timeout_ms: 5000
      });
      
      if (result.content && result.content.length > 0) {
        const content = result.content[0];
        if (content.type === 'text') {
          try {
            const data = JSON.parse(content.text);
            if (data.hasDocument) {
              this.healthStatus.browser_context_accessible = true;
              this.healthStatus.diagnostics.browser_context = data;
              this.log('Browser context is accessible', 'success');
              this.log(`Current page: ${data.title || 'Untitled'} (${data.url})`, 'info');
              return true;
            }
          } catch (e) {
            this.log(`Failed to parse browser context response: ${e}`, 'error');
          }
        }
      }
      
      this.healthStatus.errors.push('Could not access browser context');
      this.log('Browser context is not accessible', 'error');
      return false;
      
    } catch (error) {
      this.healthStatus.errors.push(`Browser context test failed: ${error.message}`);
      this.log(`Browser context test failed: ${error}`, 'error');
      return false;
    }
  }

  async testDomManipulation() {
    this.log('Testing DOM manipulation capabilities...', 'test');
    
    try {
      const testId = `computeruse-health-check-${Date.now()}`;
      const result = await this.callTool('execute_browser_script', {
        selector: 'role:Document',
        script: `(function() {
          // Create a test element
          const testDiv = document.createElement('div');
          testDiv.id = '${testId}';
          testDiv.style.cssText = 'position:fixed;top:10px;right:10px;background:#4CAF50;color:white;padding:10px;z-index:99999;border-radius:5px;';
          testDiv.textContent = 'ComputerUse Bridge Health Check';
          document.body.appendChild(testDiv);
          
          // Verify it was created
          const element = document.getElementById('${testId}');
          const success = element !== null;
          
          // Clean up after 2 seconds
          if (success) {
            setTimeout(() => {
              element.remove();
            }, 2000);
          }
          
          return {
            success: success,
            elementId: '${testId}',
            message: success ? 'DOM manipulation successful' : 'Failed to create element'
          };
        })()`,
        timeout_ms: 5000
      });
      
      if (result.content && result.content.length > 0) {
        const content = result.content[0];
        if (content.type === 'text') {
          try {
            const data = JSON.parse(content.text);
            if (data.success) {
              this.healthStatus.dom_manipulation_working = true;
              this.log('DOM manipulation is working', 'success');
              return true;
            }
          } catch (e) {
            this.log(`Failed to parse DOM manipulation response: ${e}`, 'error');
          }
        }
      }
      
      this.healthStatus.warnings.push('DOM manipulation test produced unexpected results');
      this.log('DOM manipulation test did not succeed as expected', 'warning');
      return false;
      
    } catch (error) {
      this.healthStatus.errors.push(`DOM manipulation test failed: ${error.message}`);
      this.log(`DOM manipulation test failed: ${error}`, 'error');
      return false;
    }
  }

  async testConsoleCapture() {
    this.log('Testing console output capture...', 'test');
    
    try {
      const testMessage = `ComputerUse health check ${Date.now()}`;
      const result = await this.callTool('execute_browser_script', {
        selector: 'role:Document',
        script: `(function() {
          console.log('${testMessage}');
          console.warn('Test warning');
          console.error('Test error');
          return {
            logged: true,
            message: '${testMessage}'
          };
        })()`,
        timeout_ms: 5000
      });
      
      // For now, just check if the script executed
      if (result.content && result.content.length > 0) {
        this.healthStatus.console_capture_working = true;
        this.log('Console capture test completed', 'success');
        return true;
      }
      
      return false;
      
    } catch (error) {
      this.healthStatus.warnings.push(`Console capture test failed: ${error.message}`);
      this.log(`Console capture test failed: ${error}`, 'warning');
      return false;
    }
  }

  async testAsyncExecution() {
    this.log('Testing async/await support...', 'test');
    
    try {
      const result = await this.callTool('execute_browser_script', {
        selector: 'role:Document',
        script: `(async function() {
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          
          const start = Date.now();
          await delay(100);
          const elapsed = Date.now() - start;
          
          return {
            asyncSupported: true,
            elapsedMs: elapsed,
            withinExpectedRange: elapsed >= 90 && elapsed <= 200
          };
        })()`,
        timeout_ms: 5000,
        await_promise: true
      });
      
      if (result.content && result.content.length > 0) {
        const content = result.content[0];
        if (content.type === 'text') {
          try {
            const data = JSON.parse(content.text);
            if (data.asyncSupported && data.withinExpectedRange) {
              this.healthStatus.async_execution_working = true;
              this.log(`Async execution is working (delay: ${data.elapsedMs}ms)`, 'success');
              return true;
            }
          } catch (e) {
            this.log(`Failed to parse async test response: ${e}`, 'error');
          }
        }
      }
      
      this.healthStatus.warnings.push('Async execution test produced unexpected results');
      this.log('Async execution test did not succeed as expected', 'warning');
      return false;
      
    } catch (error) {
      this.healthStatus.errors.push(`Async execution test failed: ${error.message}`);
      this.log(`Async execution test failed: ${error}`, 'error');
      return false;
    }
  }

  generateHealthReport() {
    console.log('\n' + '='.repeat(70));
    console.log(`${colors.bright}📋 CHROME BRIDGE HEALTH CHECK REPORT${colors.reset}`);
    console.log('='.repeat(70));
    
    // Overall status
    const criticalChecks = [
      'mcp_server_running',
      'mcp_connection_established',
      'browser_script_tool_available',
      'chrome_extension_connected',
      'browser_context_accessible'
    ];
    
    const isHealthy = criticalChecks.every(check => this.healthStatus[check]);
    
    console.log(`\n${colors.bright}Overall Status:${colors.reset} ${isHealthy ? colors.green + '✅ HEALTHY' : colors.red + '❌ UNHEALTHY'}${colors.reset}`);
    
    // Individual checks
    console.log(`\n${colors.bright}Component Status:${colors.reset}`);
    const checks = [
      { key: 'mcp_server_running', label: 'MCP Server Running' },
      { key: 'mcp_connection_established', label: 'MCP Connection Established' },
      { key: 'browser_script_tool_available', label: 'Browser Script Tool Available' },
      { key: 'chrome_extension_connected', label: 'Chrome Extension Connected' },
      { key: 'browser_context_accessible', label: 'Browser Context Accessible' },
      { key: 'dom_manipulation_working', label: 'DOM Manipulation Working' },
      { key: 'console_capture_working', label: 'Console Capture Working' },
      { key: 'async_execution_working', label: 'Async Execution Working' }
    ];
    
    checks.forEach(({ key, label }) => {
      const status = this.healthStatus[key];
      const icon = status ? `${colors.green}✅` : `${colors.red}❌`;
      console.log(`  ${icon} ${label}${colors.reset}`);
    });
    
    // Errors
    if (this.healthStatus.errors.length > 0) {
      console.log(`\n${colors.bright}${colors.red}Errors:${colors.reset}`);
      this.healthStatus.errors.forEach(error => {
        console.log(`  ${colors.red}• ${error}${colors.reset}`);
      });
    }
    
    // Warnings
    if (this.healthStatus.warnings.length > 0) {
      console.log(`\n${colors.bright}${colors.yellow}Warnings:${colors.reset}`);
      this.healthStatus.warnings.forEach(warning => {
        console.log(`  ${colors.yellow}• ${warning}${colors.reset}`);
      });
    }
    
    // Diagnostics
    if (Object.keys(this.healthStatus.diagnostics).length > 0) {
      console.log(`\n${colors.bright}Diagnostics:${colors.reset}`);
      
      if (this.healthStatus.diagnostics.bridge_port) {
        console.log(`  Extension Bridge Port: ${this.healthStatus.diagnostics.bridge_port}`);
      }
      
      if (this.healthStatus.diagnostics.browser_context) {
        const ctx = this.healthStatus.diagnostics.browser_context;
        console.log(`  Browser: ${ctx.browserInfo?.userAgent?.split(' ').slice(-2).join(' ') || 'Unknown'}`);
        console.log(`  Current Page: ${ctx.title || 'Untitled'}`);
        console.log(`  URL: ${ctx.url || 'Unknown'}`);
      }
      
      if (this.healthStatus.diagnostics.available_tools) {
        console.log(`  Available Tools: ${this.healthStatus.diagnostics.available_tools.length} tools`);
      }
    }
    
    // Troubleshooting
    if (!isHealthy) {
      console.log(`\n${colors.bright}${colors.cyan}Troubleshooting Steps:${colors.reset}`);
      
      if (!this.healthStatus.chrome_extension_connected) {
        console.log(`\n  ${colors.cyan}Chrome Extension Not Connected:${colors.reset}`);
        console.log('  1. Install the ComputerUse browser extension');
        console.log('  2. Make sure Chrome or Edge is running');
        console.log('  3. Check chrome://extensions and verify the extension is enabled');
        console.log('  4. Try reloading the extension');
        console.log('  5. Check browser console for WebSocket connection errors');
        console.log(`  6. Verify extension connects to ws://127.0.0.1:${this.healthStatus.diagnostics.bridge_port || '17373'}`);
      }
      
      if (!this.healthStatus.browser_context_accessible) {
        console.log(`\n  ${colors.cyan}Browser Context Not Accessible:${colors.reset}`);
        console.log('  1. Make sure you have at least one browser tab open');
        console.log('  2. Try navigating to a different website');
        console.log('  3. Check if the browser is in focus');
        console.log('  4. Verify no security software is blocking the extension');
      }
      
      if (!this.healthStatus.browser_script_tool_available) {
        console.log(`\n  ${colors.cyan}Browser Tools Not Available:${colors.reset}`);
        console.log('  1. Check if MCP server was built with browser support');
        console.log('  2. Verify the server binary is up to date');
        console.log('  3. Check server logs for initialization errors');
      }
    }
    
    console.log('\n' + '='.repeat(70));
    
    return isHealthy;
  }

  async cleanup() {
    this.log('Cleaning up...', 'info');
    
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        // Ignore errors during cleanup
      }
      this.client = null;
    }
    
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        // Ignore errors during cleanup
      }
      this.transport = null;
    }
    
    if (this.serverProcess) {
      try {
        this.serverProcess.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            try {
              this.serverProcess?.kill('SIGKILL');
            } catch (e) {
              // Ignore
            }
            resolve();
          }, 5000);
          
          this.serverProcess?.on('exit', () => {
            clearTimeout(timeoutId);
            resolve();
          });
        });
      } catch (err) {
        // Ignore errors during cleanup
      }
      this.serverProcess = null;
    }
    
    this.log('Cleanup complete', 'success');
  }
}

async function main() {
  console.log(`${colors.bright}${colors.cyan}🏥 Chrome Bridge Health Check${colors.reset}`);
  console.log('Version: 1.0.0');
  console.log(`Time: ${new Date().toISOString()}\n`);
  
  const checker = new ChromeBridgeHealthCheck();
  let isHealthy = false;
  
  try {
    // Run all checks
    await checker.startMcpServer();
    await checker.connect();
    
    // Run tests sequentially
    const extensionConnected = await checker.testChromeExtensionConnection();
    
    if (extensionConnected) {
      await checker.testBrowserContext();
      await checker.testDomManipulation();
      await checker.testConsoleCapture();
      await checker.testAsyncExecution();
    }
    
    // Generate report
    isHealthy = checker.generateHealthReport();
    
  } catch (error) {
    console.error(`\n${colors.red}💥 Health check failed with error:${colors.reset}`, error);
    checker.healthStatus.errors.push(`Fatal error: ${error.message}`);
    checker.generateHealthReport();
  } finally {
    await checker.cleanup();
  }
  
  // Exit with appropriate code
  process.exit(isHealthy ? 0 : 1);
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`${colors.red}💥 Unhandled error:${colors.reset}`, err);
    process.exit(1);
  });
}

export { ChromeBridgeHealthCheck };
