/**
 * Browser Extension Test Harness
 *
 * This test harness validates the ComputerUse Bridge Extension by:
 * 1. Starting a WebSocket server on port 17373 (extension's expected port)
 * 2. Accepting connections from the extension
 * 3. Sending eval requests and validating responses
 *
 * Usage:
 *   npx tsx test/browser-extension/test-harness.ts [options]
 *
 * Options:
 *   --port <number>     Port to listen on (default: 17373)
 *   --timeout <ms>      Test timeout (default: 30000)
 *   --interactive       Keep server running for manual testing
 *   --verbose           Show all messages
 *
 * The extension must be loaded in Chrome and the browser must have
 * at least one tab open for tests to work.
 */

import { createServer, type Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

// Configuration
const DEFAULT_PORT = 17373;
const DEFAULT_TIMEOUT = 30000;

interface EvalRequest {
  id: string;
  action: "eval";
  code: string;
  awaitPromise?: boolean;
}

interface EvalResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

// Parse command line args
const args = process.argv.slice(2);
const PORT = parseInt(
  args.find((_a, i) => args[i - 1] === "--port") || String(DEFAULT_PORT),
  10,
);
const TIMEOUT = parseInt(
  args.find((_a, i) => args[i - 1] === "--timeout") || String(DEFAULT_TIMEOUT),
  10,
);
const INTERACTIVE = args.includes("--interactive");
const VERBOSE = args.includes("--verbose");

// Test harness class
class ExtensionTestHarness {
  private server: Server;
  private wss: WebSocketServer;
  private connection: WebSocket | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: EvalResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();
  private requestId = 0;
  private results: TestResult[] = [];

  constructor(private port: number) {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws) => {
      this.log("Extension connected");
      this.connection = ws;

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as EvalResponse;
          this.handleResponse(message);
        } catch (err) {
          this.log(`Failed to parse message: ${err}`);
        }
      });

      ws.on("close", () => {
        this.log("Extension disconnected");
        this.connection = null;
      });

      ws.on("error", (err) => {
        this.log(`WebSocket error: ${err.message}`);
      });
    });
  }

  private log(message: string) {
    if (VERBOSE) {
      console.log(`[harness] ${message}`);
    }
  }

  private handleResponse(response: EvalResponse) {
    this.log(`Received response: ${JSON.stringify(response).slice(0, 200)}...`);

    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.id);
      pending.resolve(response);
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Test harness listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => {
          resolve();
        });
      });
    });
  }

  async waitForConnection(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (!this.connection && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.connection) {
      throw new Error(
        "Extension did not connect within timeout. Make sure:\n" +
          "1. The extension is loaded in Chrome (chrome://extensions)\n" +
          "2. Developer mode is enabled\n" +
          "3. At least one browser tab is open",
      );
    }
  }

  async eval(code: string, awaitPromise = false): Promise<EvalResponse> {
    if (!this.connection) {
      throw new Error("No extension connected");
    }

    const id = `test-${++this.requestId}`;
    const request: EvalRequest = {
      id,
      action: "eval",
      code,
      awaitPromise,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Eval request timed out: ${code.slice(0, 50)}...`));
      }, TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.log(`Sending eval: ${JSON.stringify(request)}`);
      this.connection?.send(JSON.stringify(request));
    });
  }

  // =========================================================================
  // TEST CASES
  // =========================================================================

  async runTest(
    name: string,
    testFn: () => Promise<void>,
  ): Promise<TestResult> {
    const start = Date.now();
    try {
      await testFn();
      const result: TestResult = {
        name,
        passed: true,
        duration: Date.now() - start,
      };
      this.results.push(result);
      console.log(`  ✓ ${name} (${result.duration}ms)`);
      return result;
    } catch (err) {
      const result: TestResult = {
        name,
        passed: false,
        duration: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
      this.results.push(result);
      console.log(`  ✗ ${name} (${result.duration}ms)`);
      console.log(`    Error: ${result.error}`);
      return result;
    }
  }

  async runAllTests(): Promise<void> {
    console.log(
      "\n═══════════════════════════════════════════════════════════",
    );
    console.log("  Browser Extension Test Suite");
    console.log(
      "═══════════════════════════════════════════════════════════\n",
    );

    // Basic eval tests
    console.log("Basic JavaScript Evaluation:");

    await this.runTest("Simple expression evaluation", async () => {
      const response = await this.eval("1 + 1");
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (response.result !== 2) {
        throw new Error(`Expected 2, got ${response.result}`);
      }
    });

    await this.runTest("String expression", async () => {
      const response = await this.eval('"hello" + " " + "world"');
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (response.result !== "hello world") {
        throw new Error(`Expected 'hello world', got ${response.result}`);
      }
    });

    await this.runTest("Array operations", async () => {
      const response = await this.eval("[1, 2, 3].map(x => x * 2)");
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      const result = response.result as number[];
      if (!Array.isArray(result) || result.join(",") !== "2,4,6") {
        throw new Error(`Expected [2,4,6], got ${JSON.stringify(result)}`);
      }
    });

    await this.runTest("Object creation", async () => {
      const response = await this.eval('({ name: "test", value: 42 })');
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      const result = response.result as { name: string; value: number };
      if (result.name !== "test" || result.value !== 42) {
        throw new Error(`Unexpected object: ${JSON.stringify(result)}`);
      }
    });

    // DOM access tests
    console.log("\nDOM Access:");

    await this.runTest("Get document title", async () => {
      const response = await this.eval("document.title");
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (typeof response.result !== "string") {
        throw new Error(`Expected string, got ${typeof response.result}`);
      }
    });

    await this.runTest("Get current URL", async () => {
      const response = await this.eval("window.location.href");
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (
        typeof response.result !== "string" ||
        !response.result.startsWith("http")
      ) {
        throw new Error(`Expected URL, got ${response.result}`);
      }
    });

    await this.runTest("Query DOM elements", async () => {
      const response = await this.eval(
        "document.querySelectorAll('*').length > 0",
      );
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (response.result !== true) {
        throw new Error("Expected page to have DOM elements");
      }
    });

    await this.runTest("Get body text content", async () => {
      const response = await this.eval(
        "document.body ? document.body.innerText.slice(0, 100) : 'no body'",
      );
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (typeof response.result !== "string") {
        throw new Error(`Expected string, got ${typeof response.result}`);
      }
    });

    // Promise handling tests
    console.log("\nPromise Handling:");

    await this.runTest("Await simple promise", async () => {
      const response = await this.eval(
        "Promise.resolve(42)",
        true, // awaitPromise
      );
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (response.result !== 42) {
        throw new Error(`Expected 42, got ${response.result}`);
      }
    });

    await this.runTest("Await delayed promise", async () => {
      const response = await this.eval(
        "new Promise(r => setTimeout(() => r('delayed'), 100))",
        true,
      );
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (response.result !== "delayed") {
        throw new Error(`Expected 'delayed', got ${response.result}`);
      }
    });

    await this.runTest("Await fetch (if available)", async () => {
      const response = await this.eval(
        `typeof fetch === 'function' ?
         fetch('https://httpbin.org/get').then(r => r.ok) :
         true`,
        true,
      );
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (response.result !== true) {
        throw new Error(`Expected true, got ${response.result}`);
      }
    });

    // Error handling tests
    console.log("\nError Handling:");

    await this.runTest("Handle syntax error", async () => {
      const response = await this.eval("function { invalid");
      if (response.ok) {
        throw new Error("Expected syntax error to fail");
      }
      if (!response.error) {
        throw new Error("Expected error message");
      }
    });

    await this.runTest("Handle runtime error", async () => {
      const response = await this.eval("nonExistentVariable.property");
      if (response.ok) {
        throw new Error("Expected reference error to fail");
      }
      if (!response.error) {
        throw new Error("Expected error message");
      }
    });

    await this.runTest("Handle rejected promise", async () => {
      const response = await this.eval(
        "Promise.reject(new Error('test rejection'))",
        true,
      );
      if (response.ok) {
        throw new Error("Expected promise rejection to fail");
      }
      if (!response.error || !response.error.includes("test rejection")) {
        throw new Error(`Expected rejection error, got: ${response.error}`);
      }
    });

    // Complex operations
    console.log("\nComplex Operations:");

    await this.runTest("Get page metadata", async () => {
      const response = await this.eval(`({
        title: document.title,
        url: window.location.href,
        elementCount: document.querySelectorAll('*').length,
        hasBody: !!document.body
      })`);
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      const result = response.result as Record<string, unknown>;
      if (!result.title || !result.url || !result.elementCount) {
        throw new Error(`Incomplete metadata: ${JSON.stringify(result)}`);
      }
    });

    await this.runTest("Find all links", async () => {
      const response = await this.eval(
        "Array.from(document.querySelectorAll('a')).slice(0, 10).map(a => ({href: a.href, text: a.textContent?.slice(0, 50)}))",
      );
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (!Array.isArray(response.result)) {
        throw new Error(`Expected array, got ${typeof response.result}`);
      }
    });

    await this.runTest("Find interactive elements", async () => {
      const response = await this.eval(`
        Array.from(document.querySelectorAll('button, input, select, textarea, [role="button"]'))
          .slice(0, 10)
          .map(el => ({
            tag: el.tagName,
            type: el.getAttribute('type'),
            name: el.getAttribute('name'),
            id: el.id || null
          }))
      `);
      if (!response.ok) throw new Error(`Eval failed: ${response.error}`);
      if (!Array.isArray(response.result)) {
        throw new Error(`Expected array, got ${typeof response.result}`);
      }
    });

    // Print summary
    this.printSummary();
  }

  printSummary(): void {
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);

    console.log(
      "\n═══════════════════════════════════════════════════════════",
    );
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Passed:  ${passed}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Total:   ${this.results.length}`);
    console.log(`  Duration: ${totalDuration}ms`);
    console.log(
      "═══════════════════════════════════════════════════════════\n",
    );

    if (failed > 0) {
      console.log("Failed tests:");
      for (const result of this.results.filter((r) => !r.passed)) {
        console.log(`  - ${result.name}: ${result.error}`);
      }
      console.log("");
    }
  }

  getResults(): TestResult[] {
    return this.results;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("Browser Extension Test Harness");
  console.log("==============================\n");

  const harness = new ExtensionTestHarness(PORT);

  try {
    await harness.start();

    console.log("Waiting for extension to connect...");
    console.log("Make sure the extension is loaded in Chrome and");
    console.log("at least one tab is open.\n");

    if (INTERACTIVE) {
      console.log("Interactive mode - server will stay running.");
      console.log("Press Ctrl+C to stop.\n");
      // Keep running
      await new Promise(() => {});
    } else {
      await harness.waitForConnection(TIMEOUT);
      await harness.runAllTests();

      const results = harness.getResults();
      const failed = results.filter((r) => !r.passed).length;

      await harness.stop();
      process.exit(failed > 0 ? 1 : 0);
    }
  } catch (err) {
    console.error("\nError:", err instanceof Error ? err.message : String(err));
    await harness.stop();
    process.exit(1);
  }
}

main();
