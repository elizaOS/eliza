const { Desktop } = require("../index.js");

/**
 * Test for Element.locator() chaining functionality
 * This test verifies the fix for issue #258 where Element.locator() chaining would fail
 * due to expensive WindowsEngine creation on every call.
 */
async function testElementChaining() {
  console.log("🔗 Testing Element.locator() chaining...");

  try {
    const desktop = new Desktop();

    // Get any available application for testing
    const apps = desktop.applications();
    if (apps.length === 0) {
      throw new Error("No applications found for testing");
    }

    const testApp = apps[0];
    console.log(`📱 Testing with app: ${testApp.name()}`);

    // Test 1: Basic chaining - this was the main issue
    console.log("Test 1: Basic element chaining");
    const windowLocator = testApp.locator("role:window");
    const buttonLocator = windowLocator.locator("role:button");
    console.log("✅ Basic chaining works");

    // Test 2: Multiple chaining levels
    console.log("Test 2: Multiple chaining levels");
    const deepChain = testApp
      .locator("role:window")
      .locator("role:pane")
      .locator("role:button");
    console.log("✅ Deep chaining works");

    // Test 3: Stress test - create many locators quickly
    console.log("Test 3: Stress test (50 rapid chains)");
    const startTime = Date.now();
    for (let i = 0; i < 50; i++) {
      const locator = testApp.locator("role:window").locator("role:button");
      // Just create the locator, don't need to use it
    }
    const endTime = Date.now();
    console.log(`✅ Created 50 chained locators in ${endTime - startTime}ms`);

    // Test 4: Concurrent chaining
    console.log("Test 4: Concurrent chaining");
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        Promise.resolve().then(() => {
          return testApp.locator("role:window").locator("role:text");
        })
      );
    }
    await Promise.all(promises);
    console.log("✅ Concurrent chaining works");

    return true;
  } catch (error) {
    console.error("❌ Element chaining test failed:", error.message);
    return false;
  }
}

/**
 * Test for Wikipedia-specific chaining (if Wikipedia is available)
 */
async function testWikipediaChaining() {
  console.log("🌐 Testing Wikipedia-specific chaining...");

  try {
    const desktop = new Desktop();

    // Try to find Wikipedia page
    try {
      const wikipediaLocator = desktop.locator("role:document|wikipedia");
      const w = await wikipediaLocator.first(0); // timeout in ms (0 = immediate)
      console.log(`📖 Found Wikipedia page: ${w.name()}`);

      // Test the original failing case
      const textLocator = w.locator("role:text|wikipedia");
      console.log("✅ Wikipedia element chaining works");

      // Try to find some elements
      try {
        const elements = await textLocator.all(2000);
        console.log(`✅ Found ${elements.length} Wikipedia text elements`);
      } catch (err) {
        console.log("ℹ️  No specific Wikipedia text elements found (normal)");
      }

      return true;
    } catch (err) {
      if (err.message.includes("Timed out")) {
        console.log(
          "ℹ️  No Wikipedia page found - skipping Wikipedia-specific test"
        );
        return true; // Not a failure, just no Wikipedia available
      }
      throw err;
    }
  } catch (error) {
    console.error("❌ Wikipedia chaining test failed:", error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runChainingTests() {
  console.log("🚀 Starting Element.locator() chaining tests...\n");

  let passed = 0;
  let total = 0;

  // Test 1: Basic element chaining
  total++;
  if (await testElementChaining()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 2: Wikipedia-specific chaining
  total++;
  if (await testWikipediaChaining()) {
    passed++;
  }

  console.log(); // Empty line

  // Results
  if (passed === total) {
    console.log(`🎉 All chaining tests passed! (${passed}/${total})`);
    process.exit(0);
  } else {
    console.log(`❌ Some tests failed: ${passed}/${total} passed`);
    process.exit(1);
  }
}

// Export for use in other test files
module.exports = {
  testElementChaining,
  testWikipediaChaining,
  runChainingTests,
};

// Run tests if this file is executed directly
if (require.main === module) {
  runChainingTests().catch((error) => {
    console.error("💥 Test runner crashed:", error);
    process.exit(1);
  });
}
