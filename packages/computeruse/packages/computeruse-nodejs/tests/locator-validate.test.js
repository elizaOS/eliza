const { Desktop } = require("../index.js");

/**
 * Test for Locator.validate() method
 * This test verifies that validate() returns ValidationResult without throwing errors
 */
async function testValidateExists() {
  console.log("🔍 Testing Locator.validate() for existing elements...");

  try {
    const desktop = new Desktop();

    // Get any available application for testing
    const apps = desktop.applications();
    if (apps.length === 0) {
      throw new Error("No applications found for testing");
    }

    const testApp = apps[0];
    console.log(`📱 Testing with app: ${testApp.name()}`);

    // Test 1: Validate an existing element (the app window itself)
    console.log("Test 1: Validate existing element");
    const result = await desktop.locator("role:window").validate(2000);

    if (!result.exists) {
      throw new Error("Expected element to exist");
    }
    if (!result.element) {
      throw new Error("Expected element to be present in result");
    }
    if (result.error) {
      throw new Error(`Expected no error, got: ${result.error}`);
    }

    console.log(`✅ Window element found: ${result.element.name()}`);

    return true;
  } catch (error) {
    console.error("❌ Validate exists test failed:", error.message);
    return false;
  }
}

/**
 * Test validate() with non-existent element
 */
async function testValidateNotExists() {
  console.log("🔍 Testing Locator.validate() for non-existent elements...");

  try {
    const desktop = new Desktop();

    // Test: Validate a non-existent element
    console.log("Test: Validate non-existent element");
    const result = await desktop
      .locator("role:button|ThisButtonDoesNotExist12345XYZ")
      .validate(1000);

    if (result.exists) {
      throw new Error("Expected element to not exist");
    }
    if (result.element) {
      throw new Error("Expected element to be undefined");
    }
    if (result.error) {
      // Errors should only happen for invalid selectors, not for "not found"
      throw new Error(`Unexpected error in validation: ${result.error}`);
    }

    console.log("✅ Correctly reported element as not existing");

    return true;
  } catch (error) {
    console.error("❌ Validate not exists test failed:", error.message);
    return false;
  }
}

/**
 * Test validate() with chained locators
 */
async function testValidateChaining() {
  console.log("🔍 Testing Locator.validate() with chaining...");

  try {
    const desktop = new Desktop();
    const apps = desktop.applications();

    if (apps.length === 0) {
      throw new Error("No applications found for testing");
    }

    const testApp = apps[0];

    // Test: Validate with chained locator
    console.log("Test: Validate with chained locator");
    const result = await testApp
      .locator("role:window")
      .locator("role:button")
      .validate(2000);

    // Either exists or doesn't exist - both are valid, we just check no crash
    if (result.exists) {
      console.log(`✅ Found button in chain: ${result.element.name()}`);
    } else {
      console.log("✅ No button found in chain (expected)");
    }

    if (result.error) {
      throw new Error(`Unexpected error: ${result.error}`);
    }

    return true;
  } catch (error) {
    console.error("❌ Validate chaining test failed:", error.message);
    return false;
  }
}

/**
 * Test validate() with zero timeout
 */
async function testValidateZeroTimeout() {
  console.log("🔍 Testing Locator.validate() with zero timeout...");

  try {
    const desktop = new Desktop();

    // Test: Immediate validation (no retry)
    console.log("Test: Validate with zero timeout (immediate)");
    const result = await desktop.locator("role:window").validate(0);

    // With zero timeout, should still find immediate elements
    console.log(`✅ Immediate validation returned: exists=${result.exists}`);

    return true;
  } catch (error) {
    console.error("❌ Validate zero timeout test failed:", error.message);
    return false;
  }
}

/**
 * Test that validate() doesn't throw like first() does
 */
async function testValidateVsFirst() {
  console.log("🔍 Testing validate() vs first() behavior...");

  try {
    const desktop = new Desktop();
    const selector = "role:button|ThisButtonDoesNotExist12345XYZ";

    // Test: first() should throw
    console.log("Test: Verifying first() throws on not found");
    let firstThrew = false;
    try {
      await desktop.locator(selector).first(500);
    } catch (err) {
      firstThrew = true;
      console.log("✅ first() correctly threw error");
    }

    if (!firstThrew) {
      throw new Error("Expected first() to throw, but it didn't");
    }

    // Test: validate() should NOT throw
    console.log("Test: Verifying validate() doesn't throw on not found");
    const result = await desktop.locator(selector).validate(500);

    if (result.exists) {
      throw new Error("Expected element to not exist");
    }

    console.log("✅ validate() correctly returned {exists: false} without throwing");

    return true;
  } catch (error) {
    console.error("❌ Validate vs first test failed:", error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runValidateTests() {
  console.log("🚀 Starting Locator.validate() tests...\n");

  let passed = 0;
  let total = 0;

  // Test 1: Validate existing element
  total++;
  if (await testValidateExists()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 2: Validate non-existent element
  total++;
  if (await testValidateNotExists()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 3: Validate with chaining
  total++;
  if (await testValidateChaining()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 4: Validate with zero timeout
  total++;
  if (await testValidateZeroTimeout()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 5: Validate vs first behavior
  total++;
  if (await testValidateVsFirst()) {
    passed++;
  }

  console.log(); // Empty line

  // Results
  if (passed === total) {
    console.log(`🎉 All validate tests passed! (${passed}/${total})`);
    process.exit(0);
  } else {
    console.log(`❌ Some tests failed: ${passed}/${total} passed`);
    process.exit(1);
  }
}

// Export for use in other test files
module.exports = {
  testValidateExists,
  testValidateNotExists,
  testValidateChaining,
  testValidateZeroTimeout,
  testValidateVsFirst,
  runValidateTests,
};

// Run tests if this file is executed directly
if (require.main === module) {
  runValidateTests().catch((error) => {
    console.error("💥 Test runner crashed:", error);
    process.exit(1);
  });
}
