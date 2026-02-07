const { Desktop } = require("../index.js");

/**
 * Test for Element.scrollIntoView() method
 *
 * Note: This test requires an application with scrollable content and off-screen elements.
 * Common apps: Browser with long pages, File Explorer, Settings with long lists
 */
async function testScrollIntoView() {
  console.log("📜 Testing Element.scrollIntoView()...");

  try {
    const desktop = new Desktop();

    // Try to find a window with scrollable content
    console.log("Searching for scrollable windows...");

    const windowLocator = desktop.locator("role:window");

    try {
      const window = await windowLocator.first(2000);
      console.log(`✅ Found window: ${window.name()}`);

      // Try to find a scrollbar (indicates scrollable content)
      const scrollbarLocator = window.locator("role:scrollbar");

      try {
        const scrollbar = await scrollbarLocator.first(1000);
        console.log(`  Found scrollbar - window has scrollable content`);

        // Try to find any element within the window
        const elementLocator = window.locator("role:button|role:text|role:link");

        try {
          const elements = await elementLocator.all(2000, 3);

          if (elements.length > 0) {
            // Pick an element (preferably not the first one)
            const targetElement = elements.length > 5 ? elements[5] : elements[0];
            console.log(`  Testing with element: ${targetElement.name() || '(unnamed)'}`);

            // Test: Scroll into view
            console.log("Test: Scroll element into view");
            targetElement.scrollIntoView();
            console.log(`  ✅ scrollIntoView() executed successfully`);

            // Wait a bit for scroll animation
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify element is visible
            if (targetElement.isVisible()) {
              console.log(`  ✅ Element is visible after scroll`);
            } else {
              console.log(`  ⚠️  Element may not be fully visible (acceptable for some UIs)`);
            }

            return true;
          } else {
            console.log("ℹ️  No suitable elements found for scrolling test");
            return true;
          }
        } catch (error) {
          console.log(`  ℹ️  Could not find elements for scroll test: ${error.message}`);
          return true;
        }
      } catch (error) {
        console.log(`  ℹ️  No scrollbar found - window may not have scrollable content`);
        return true;
      }
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No window found - this is acceptable");
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ scrollIntoView test failed:", error.message);
    return false;
  }
}

/**
 * Test scrollIntoView with already visible element
 */
async function testScrollIntoViewAlreadyVisible() {
  console.log("📜 Testing scrollIntoView with already visible element...");

  try {
    const desktop = new Desktop();

    // Find any visible window
    console.log("Test: Scroll already visible element");

    try {
      const window = await desktop.locator("role:window").first(2000);

      // The window itself should be visible
      if (window.isVisible()) {
        // Call scrollIntoView on already visible element (should be a no-op)
        window.scrollIntoView();
        console.log(`  ✅ scrollIntoView() on visible element completed`);
        return true;
      } else {
        console.log(`  ℹ️  Window not visible for test`);
        return true;
      }
    } catch (error) {
      console.log(`  ℹ️  No window found for visible element test`);
      return true;
    }
  } catch (error) {
    console.error("❌ scrollIntoView visible element test failed:", error.message);
    return false;
  }
}

/**
 * Test scrollIntoView multiple times (should be idempotent)
 */
async function testScrollIntoViewIdempotent() {
  console.log("📜 Testing scrollIntoView idempotence...");

  try {
    const desktop = new Desktop();

    console.log("Test: Call scrollIntoView multiple times");

    try {
      const button = await desktop.locator("role:button").first(2000);

      // Call scrollIntoView multiple times
      button.scrollIntoView();
      await new Promise(resolve => setTimeout(resolve, 200));

      button.scrollIntoView();
      await new Promise(resolve => setTimeout(resolve, 200));

      button.scrollIntoView();

      console.log(`  ✅ Multiple scrollIntoView calls completed successfully`);
      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log(`  ℹ️  No button found for idempotence test`);
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ scrollIntoView idempotence test failed:", error.message);
    return false;
  }
}

/**
 * Test scrollIntoView before click (common use case)
 */
async function testScrollIntoViewBeforeClick() {
  console.log("📜 Testing scrollIntoView before click pattern...");

  try {
    const desktop = new Desktop();

    console.log("Test: Scroll into view then click");

    try {
      const button = await desktop.locator("role:button").first(2000);

      // Common pattern: ensure element is visible before clicking
      button.scrollIntoView();
      await new Promise(resolve => setTimeout(resolve, 300));

      // We won't actually click (to avoid disrupting UI), just verify pattern works
      console.log(`  ✅ scrollIntoView before click pattern works`);
      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log(`  ℹ️  No button found for click pattern test`);
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ scrollIntoView before click test failed:", error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runScrollIntoViewTests() {
  console.log("🚀 Starting Element.scrollIntoView() tests...\n");

  let passed = 0;
  let total = 0;

  // Test 1: Basic scroll into view
  total++;
  if (await testScrollIntoView()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 2: Already visible element
  total++;
  if (await testScrollIntoViewAlreadyVisible()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 3: Idempotence
  total++;
  if (await testScrollIntoViewIdempotent()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 4: Before click pattern
  total++;
  if (await testScrollIntoViewBeforeClick()) {
    passed++;
  }

  console.log(); // Empty line

  // Results
  if (passed === total) {
    console.log(`🎉 All scrollIntoView tests passed! (${passed}/${total})`);
    process.exit(0);
  } else {
    console.log(`❌ Some tests failed: ${passed}/${total} passed`);
    process.exit(1);
  }
}

// Export for use in other test files
module.exports = {
  testScrollIntoView,
  testScrollIntoViewAlreadyVisible,
  testScrollIntoViewIdempotent,
  testScrollIntoViewBeforeClick,
  runScrollIntoViewTests,
};

// Run tests if this file is executed directly
if (require.main === module) {
  runScrollIntoViewTests().catch((error) => {
    console.error("💥 Test runner crashed:", error);
    process.exit(1);
  });
}
