#!/usr/bin/env node

// This script executes when someone runs 'npm create eliza'
// It directly runs the elizaOS CLI init command using a bundled copy of the CLI

try {
	// Set up process.argv to make it look like the user called 'eliza init'
	// This avoids having to install the CLI package separately through npx
	process.argv = [process.argv[0], process.argv[1], "init"];

	// Import the bundled CLI - it automatically parses process.argv and runs the command
	require("./cli/index.js");
} catch (error) {
	console.error("Failed to initialize Eliza project:", error.message);
	process.exit(1);
}
