#!/usr/bin/env bun

import { $ } from "bun";
import { platform } from "os";

// Skip postinstall in CI/test environments
if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.TEST_MODE) {
  console.log("Skipping Ollama installation in CI/test environment");
  process.exit(0);
}

const isWindows = platform() === "win32";
const isMac = platform() === "darwin";
const isLinux = platform() === "linux";

console.log("Checking Ollama installation...");

async function main() {
  try {
    // Check if ollama is already installed
    try {
      await $`ollama --version`.quiet();
      console.log("Ollama is already installed.");
    } catch {
      // Ollama not installed, try to install it
      if (isWindows) {
        console.log(
          "Windows detected. Please download and install Ollama from: https://ollama.com/download/windows",
        );
        console.log(
          "After installation, run: ollama pull nomic-embed-text:latest",
        );
        return;
      } else if (isMac || isLinux) {
        console.log("Installing Ollama using the official installer...");
        try {
          await $`curl -fsSL https://ollama.com/install.sh | sh`;
          console.log("Ollama installed successfully!");
        } catch (error) {
          console.warn(
            "Could not install Ollama automatically. This might be a CI environment.",
          );
          console.log(
            "Please install Ollama manually from: https://ollama.com/download",
          );
          return;
        }
      } else {
        console.log(
          "Unsupported platform. Please install Ollama manually from: https://ollama.com/download",
        );
        return;
      }
    }

    // Try to pull the required model
    console.log("\nTrying to pull required embedding model...");
    try {
      await $`ollama pull nomic-embed-text:latest`;
      console.log("Successfully pulled nomic-embed-text model!");
    } catch (error) {
      console.log(
        'Could not pull model. You may need to run "ollama pull nomic-embed-text:latest" manually after starting Ollama.',
      );
    }
  } catch (error) {
    console.error("Unexpected error:", error.message);
  }
}

main().catch(console.error);
