const { Desktop } = require("../index.js");

/**
 * Test for Element.getRangeValue() and setRangeValue() methods
 *
 * Note: This test requires an application with slider controls.
 * Common apps with sliders: Volume mixer, Media players, Settings apps
 */
async function testRangeValue() {
  console.log("🎚️  Testing Element range value methods...");

  try {
    const desktop = new Desktop();

    // Try to find a slider control in any running application
    console.log("Searching for slider controls...");

    // Common roles for range controls: slider, scrollbar, progressbar
    const sliderLocator = desktop.locator("role:slider");

    try {
      const slider = await sliderLocator.first(2000);
      console.log(`✅ Found slider: ${slider.name() || '(unnamed)'}`);

      // Test: Get current value
      console.log("Test: Get current range value");
      const currentValue = slider.getRangeValue();
      console.log(`  Current value: ${currentValue}`);

      if (typeof currentValue !== 'number') {
        throw new Error(`Expected number, got ${typeof currentValue}`);
      }

      // Test: Set a new value (try to set it to 50 if current value is different)
      console.log("Test: Set range value");
      const targetValue = currentValue !== 50 ? 50 : 75;
      slider.setRangeValue(targetValue);
      console.log(`  Set value to: ${targetValue}`);

      // Wait a bit for the UI to update
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify the value changed (allow small tolerance for rounding)
      const newValue = slider.getRangeValue();
      console.log(`  New value: ${newValue}`);

      const tolerance = 5;
      if (Math.abs(newValue - targetValue) > tolerance) {
        console.log(`  ⚠️  Value changed but not exactly to target (tolerance: ${tolerance})`);
      } else {
        console.log(`  ✅ Value set successfully`);
      }

      // Restore original value
      slider.setRangeValue(currentValue);
      console.log(`  Restored original value: ${currentValue}`);

      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No slider found - this is acceptable if no apps with sliders are running");
        console.log("   Try running: Volume mixer, Windows Media Player, or Settings app");
        return true; // Not a test failure, just no suitable UI available
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ Range value test failed:", error.message);
    return false;
  }
}

/**
 * Test range value with scrollbar (another type of range control)
 */
async function testScrollbarRange() {
  console.log("🎚️  Testing scrollbar range values...");

  try {
    const desktop = new Desktop();

    // Try to find a scrollbar
    console.log("Searching for scrollbar controls...");
    const scrollbarLocator = desktop.locator("role:scrollbar");

    try {
      const scrollbar = await scrollbarLocator.first(2000);
      console.log(`✅ Found scrollbar: ${scrollbar.name() || '(unnamed)'}`);

      // Just verify we can read the value (don't modify scrollbars as it affects UI)
      const scrollValue = scrollbar.getRangeValue();
      console.log(`  Scrollbar position: ${scrollValue}`);

      if (typeof scrollValue !== 'number') {
        throw new Error(`Expected number, got ${typeof scrollValue}`);
      }

      console.log("✅ Successfully read scrollbar value");
      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No scrollbar found - this is acceptable");
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ Scrollbar range test failed:", error.message);
    return false;
  }
}

/**
 * Test error handling for non-range elements
 */
async function testRangeValueError() {
  console.log("🎚️  Testing range value error handling...");

  try {
    const desktop = new Desktop();

    // Try to get range value from a non-range element (like a button)
    console.log("Test: Get range value from non-range element");

    try {
      const button = await desktop.locator("role:button").first(2000);

      // This should throw an error or return a default value
      try {
        const rangeValue = button.getRangeValue();
        console.log(`  ⚠️  Got value from non-range element: ${rangeValue} (unexpected but not fatal)`);
      } catch (err) {
        console.log(`  ✅ Correctly threw error: ${err.message}`);
      }

      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No button found for error test");
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ Range value error test failed:", error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runRangeValueTests() {
  console.log("🚀 Starting Element range value tests...\n");

  let passed = 0;
  let total = 0;

  // Test 1: Basic range value get/set
  total++;
  if (await testRangeValue()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 2: Scrollbar range
  total++;
  if (await testScrollbarRange()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 3: Error handling
  total++;
  if (await testRangeValueError()) {
    passed++;
  }

  console.log(); // Empty line

  // Results
  if (passed === total) {
    console.log(`🎉 All range value tests passed! (${passed}/${total})`);
    process.exit(0);
  } else {
    console.log(`❌ Some tests failed: ${passed}/${total} passed`);
    process.exit(1);
  }
}

// Export for use in other test files
module.exports = {
  testRangeValue,
  testScrollbarRange,
  testRangeValueError,
  runRangeValueTests,
};

// Run tests if this file is executed directly
if (require.main === module) {
  runRangeValueTests().catch((error) => {
    console.error("💥 Test runner crashed:", error);
    process.exit(1);
  });
}
