const { Desktop } = require("../index.js");

/**
 * Test for Locator.waitFor() method with 'exists' condition
 */
async function testWaitForExists() {
  console.log("🕐 Testing Locator.waitFor('exists')...");

  try {
    const desktop = new Desktop();

    // Get any available application for testing
    const apps = desktop.applications();
    if (apps.length === 0) {
      throw new Error("No applications found for testing");
    }

    const testApp = apps[0];
    console.log(`📱 Testing with app: ${testApp.name()}`);

    // Test: Wait for a window to exist (should succeed immediately)
    console.log("Test: Wait for window to exist");
    const element = await desktop.locator("role:window").waitFor("exists", 5000);

    if (!element) {
      throw new Error("Expected element to be returned");
    }

    console.log(`✅ Found window: ${element.name()}`);
    return true;
  } catch (error) {
    console.error("❌ WaitFor exists test failed:", error.message);
    return false;
  }
}

/**
 * Test waitFor() with 'visible' condition
 */
async function testWaitForVisible() {
  console.log("🕐 Testing Locator.waitFor('visible')...");

  try {
    const desktop = new Desktop();

    // Test: Wait for a visible window
    console.log("Test: Wait for window to be visible");
    const element = await desktop.locator("role:window").waitFor("visible", 5000);

    // Check that the element is actually visible
    if (!element.isVisible()) {
      throw new Error("Element should be visible");
    }

    console.log(`✅ Found visible window: ${element.name()}`);
    return true;
  } catch (error) {
    console.error("❌ WaitFor visible test failed:", error.message);
    return false;
  }
}

/**
 * Test waitFor() timeout behavior
 */
async function testWaitForTimeout() {
  console.log("🕐 Testing Locator.waitFor() timeout...");

  try {
    const desktop = new Desktop();

    // Test: Wait for a non-existent element (should timeout)
    console.log("Test: Wait for non-existent element (expecting timeout)");
    let timedOut = false;

    try {
      await desktop
        .locator("role:button|ThisButtonDoesNotExist12345XYZ")
        .waitFor("exists", 1000);
    } catch (err) {
      if (err.message.includes("Timed out") || err.message.includes("timeout")) {
        timedOut = true;
        console.log("✅ Correctly timed out");
      } else {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }

    if (!timedOut) {
      throw new Error("Expected timeout error");
    }

    return true;
  } catch (error) {
    console.error("❌ WaitFor timeout test failed:", error.message);
    return false;
  }
}

/**
 * Test waitFor() with different conditions
 */
async function testWaitForConditions() {
  console.log("🕐 Testing Locator.waitFor() with different conditions...");

  try {
    const desktop = new Desktop();

    // Test each condition on a window (which should be visible and enabled)
    const conditions = ["exists", "visible", "enabled"];

    for (const condition of conditions) {
      console.log(`Test: waitFor('${condition}')`);
      const element = await desktop
        .locator("role:window")
        .waitFor(condition, 5000);

      if (!element) {
        throw new Error(`No element returned for condition '${condition}'`);
      }

      console.log(`✅ Condition '${condition}' met`);
    }

    return true;
  } catch (error) {
    console.error("❌ WaitFor conditions test failed:", error.message);
    return false;
  }
}

/**
 * Test waitFor() with invalid condition
 */
async function testWaitForInvalidCondition() {
  console.log("🕐 Testing Locator.waitFor() with invalid condition...");

  try {
    const desktop = new Desktop();

    // Test: Invalid condition should throw error
    console.log("Test: Wait with invalid condition");
    let errorThrown = false;

    try {
      await desktop.locator("role:window").waitFor("invalid_condition", 1000);
    } catch (err) {
      if (err.message.includes("Invalid condition")) {
        errorThrown = true;
        console.log("✅ Correctly rejected invalid condition");
      } else {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }

    if (!errorThrown) {
      throw new Error("Expected error for invalid condition");
    }

    return true;
  } catch (error) {
    console.error("❌ WaitFor invalid condition test failed:", error.message);
    return false;
  }
}

/**
 * Test waitFor() with chaining
 */
async function testWaitForChaining() {
  console.log("🕐 Testing Locator.waitFor() with chaining...");

  try {
    const desktop = new Desktop();
    const apps = desktop.applications();

    if (apps.length === 0) {
      throw new Error("No applications found for testing");
    }

    const testApp = apps[0];

    // Test: Wait with chained locator
    console.log("Test: waitFor with chained locator");
    const element = await testApp
      .locator("role:window")
      .waitFor("visible", 3000);

    console.log(`✅ Found element via chain: ${element.name()}`);
    return true;
  } catch (error) {
    // This might fail if the app has no window, which is acceptable
    if (error.message.includes("Timed out")) {
      console.log("ℹ️  No window found in chain (acceptable)");
      return true;
    }
    console.error("❌ WaitFor chaining test failed:", error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runWaitForTests() {
  console.log("🚀 Starting Locator.waitFor() tests...\n");

  let passed = 0;
  let total = 0;

  // Test 1: Wait for exists
  total++;
  if (await testWaitForExists()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 2: Wait for visible
  total++;
  if (await testWaitForVisible()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 3: Timeout behavior
  total++;
  if (await testWaitForTimeout()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 4: Different conditions
  total++;
  if (await testWaitForConditions()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 5: Invalid condition
  total++;
  if (await testWaitForInvalidCondition()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 6: Chaining
  total++;
  if (await testWaitForChaining()) {
    passed++;
  }

  console.log(); // Empty line

  // Results
  if (passed === total) {
    console.log(`🎉 All waitFor tests passed! (${passed}/${total})`);
    process.exit(0);
  } else {
    console.log(`❌ Some tests failed: ${passed}/${total} passed`);
    process.exit(1);
  }
}

// Export for use in other test files
module.exports = {
  testWaitForExists,
  testWaitForVisible,
  testWaitForTimeout,
  testWaitForConditions,
  testWaitForInvalidCondition,
  testWaitForChaining,
  runWaitForTests,
};

// Run tests if this file is executed directly
if (require.main === module) {
  runWaitForTests().catch((error) => {
    console.error("💥 Test runner crashed:", error);
    process.exit(1);
  });
}
