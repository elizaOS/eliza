/**
 * TypeScript Runtime Loading Plugins from All Languages
 *
 * This example demonstrates how the TypeScript runtime can load:
 * - Rust plugins via WASM
 * - Python plugins via IPC subprocess
 * - Native TypeScript plugins directly
 *
 * @example
 * ```bash
 * npx ts-node ts-loads-all.ts
 * ```
 */

import type { Memory, State } from "@elizaos/core";
import {
  loadPlugin,
  loadPythonPlugin,
  loadWasmPlugin,
  stopPythonPlugin,
} from "@elizaos/interop";

// ============================================================================
// Example 1: Load Rust Plugin via WASM
// ============================================================================

async function loadRustViaWasm(): Promise<void> {
  console.log("\n=== Loading Rust Plugin via WASM ===\n");

  try {
    // Path to compiled WASM module
    const wasmPath =
      "../../../plugins/plugin-eliza-classic/rust/pkg/elizaos_plugin_eliza_classic_bg.wasm";

    const plugin = await loadWasmPlugin(wasmPath);

    console.log(`Plugin: ${plugin.name}`);
    console.log(`Description: ${plugin.description}`);
    console.log(`Actions: ${plugin.actions?.map((a) => a.name).join(", ")}`);

    // Test the action
    if (plugin.actions && plugin.actions.length > 0) {
      const action = plugin.actions[0];
      const agentRuntime = {} as Parameters<typeof action.handler>[0];
      const mockMemory: Memory = {
        id: "123" as `${string}-${string}-${string}-${string}-${string}`,
        agentId: "456" as `${string}-${string}-${string}-${string}-${string}`,
        roomId: "789" as `${string}-${string}-${string}-${string}-${string}`,
        entityId: "abc" as `${string}-${string}-${string}-${string}-${string}`,
        content: { text: "I am feeling sad today" },
        createdAt: Date.now(),
      };
      const mockState: State = { values: {}, data: {} };

      console.log('\nInvoking action with: "I am feeling sad today"');
      const result = await action.handler(
        agentRuntime,
        mockMemory,
        mockState,
        {},
      );
      console.log(`Response: ${result?.text || "No response"}`);
    }
  } catch (error) {
    console.log(
      "WASM loading skipped (build WASM first with: cargo build --features wasm)",
    );
    console.log(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

// ============================================================================
// Example 2: Load Python Plugin via IPC
// ============================================================================

async function loadPythonViaIpc(): Promise<void> {
  console.log("\n=== Loading Python Plugin via IPC ===\n");

  try {
    // Path to Python plugin
    const pythonPluginPath = "../../../plugins/plugin-eliza-classic/python";

    const plugin = await loadPythonPlugin(pythonPluginPath);

    console.log(`Plugin: ${plugin.name}`);
    console.log(`Description: ${plugin.description}`);
    console.log(`Actions: ${plugin.actions?.map((a) => a.name).join(", ")}`);

    // Test the action
    if (plugin.actions && plugin.actions.length > 0) {
      const action = plugin.actions[0];
      const agentRuntime = {} as Parameters<typeof action.handler>[0];
      const mockMemory: Memory = {
        id: "123" as `${string}-${string}-${string}-${string}-${string}`,
        agentId: "456" as `${string}-${string}-${string}-${string}-${string}`,
        roomId: "789" as `${string}-${string}-${string}-${string}-${string}`,
        entityId: "abc" as `${string}-${string}-${string}-${string}-${string}`,
        content: { text: "I remember my childhood" },
        createdAt: Date.now(),
      };
      const mockState: State = { values: {}, data: {} };

      console.log('\nInvoking action with: "I remember my childhood"');
      const result = await action.handler(
        agentRuntime,
        mockMemory,
        mockState,
        {},
      );
      console.log(`Response: ${result?.text || "No response"}`);
    }

    // Clean up
    stopPythonPlugin(pythonPluginPath);
  } catch (error) {
    console.log(
      "Python IPC loading skipped (ensure Python environment is set up)",
    );
    console.log(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

// ============================================================================
// Example 3: Universal Plugin Loader
// ============================================================================

async function universalLoader(): Promise<void> {
  console.log("\n=== Universal Plugin Loader ===\n");

  // The universal loader auto-detects plugin type from plugin.json manifest
  const pluginPaths = [
    "../../../plugins/plugin-eliza-classic/rust",
    "../../../plugins/plugin-eliza-classic/python",
    "../../../plugins/plugin-eliza-classic/typescript",
  ];

  for (const path of pluginPaths) {
    try {
      console.log(`\nAttempting to load: ${path}`);
      const plugin = await loadPlugin(path);
      console.log(`✓ Loaded: ${plugin.name} (${plugin.description})`);
    } catch (error) {
      console.log(
        `✗ Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("TypeScript Runtime - Cross-Language Plugin Loading Demo");
  console.log("=".repeat(60));

  await loadRustViaWasm();
  await loadPythonViaIpc();
  await universalLoader();

  console.log(`\n${"=".repeat(60)}`);
  console.log("Demo complete!");
  console.log("=".repeat(60));
}

main().catch(console.error);
