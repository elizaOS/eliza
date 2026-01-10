// Test setup for plugin-mcp TypeScript tests
// This file is loaded before all tests

// Ensure proper async handling
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});


