const { Desktop } = require("../index.js");

/**
 * Cross-Application Verification Test Suite
 * Tests verification methods across multiple Windows built-in applications
 * These apps are available on all Windows 10/11 computers
 */

const desktop = new Desktop();

// Test configuration for each app
const APP_TESTS = [
  {
    name: "Notepad",
    launch: "notepad.exe",
    existsSelector: "role:Document || role:Edit",
    existsDescription: "text editor area",
    menuBarSelector: "role:MenuBar",
    notExistsSelector: "role:Window && name:Save As",
    notExistsDescription: "Save As dialog",
    required: true,
  },
  {
    name: "Calculator",
    launch: "calc",
    existsSelector: "role:Button && name:Zero",
    existsDescription: "Zero button",
    menuBarSelector: null, // Calculator has no traditional menu bar
    notExistsSelector: "role:Button && name:NonExistentCalcButton",
    notExistsDescription: "non-existent button",
    required: true,
  },
  {
    name: "Google Chrome",
    launch: "chrome",
    existsSelector: "role:Document || role:Pane",
    existsDescription: "browser content area",
    menuBarSelector: null, // Chrome uses toolbar, not menu bar
    notExistsSelector: "role:Window && name:Downloads Complete",
    notExistsDescription: "Downloads Complete dialog",
    required: false, // Chrome may not be installed
  },
  {
    name: "Microsoft Edge",
    launch: "msedge",
    existsSelector: "role:Document || role:Pane",
    existsDescription: "browser content area",
    menuBarSelector: null, // Edge uses toolbar, not menu bar
    notExistsSelector: "role:Window && name:Downloads Complete",
    notExistsDescription: "Downloads Complete dialog",
    required: false, // Edge can fail if already open or slow to launch
  },
  {
    name: "File Explorer",
    launch: "explorer",
    existsSelector: "role:Pane",
    existsDescription: "content pane",
    menuBarSelector: null, // Modern Explorer uses ribbon
    notExistsSelector: "role:Window && name:Confirm Delete",
    notExistsDescription: "Confirm Delete dialog",
    required: false, // Explorer has complex window structure, can be flaky
  },
];

async function closeApp(appElement, appName) {
  try {
    await appElement.pressKey("Alt+F4");
    await new Promise(r => setTimeout(r, 500));

    // Handle save dialogs if they appear
    try {
      const dontSave = await appElement.locator("role:Button && name:Don\\'t Save").first(1000);
      await dontSave.click();
    } catch {
      // Try "No" button for some dialogs
      try {
        const noBtn = await appElement.locator("role:Button && name:No").first(500);
        await noBtn.click();
      } catch {
        // No dialog, that's fine
      }
    }
  } catch (e) {
    console.log(`    Note: Could not close ${appName} cleanly: ${e.message.substring(0, 50)}`);
  }
}

async function testApp(config) {
  console.log(`\n  ═══ ${config.name} ═══`);

  let appElement = null;
  let passed = 0;
  let failed = 0;
  let skipped = false;

  try {
    // Launch app
    console.log(`  Launching ${config.name}...`);
    try {
      appElement = await desktop.openApplication(config.launch);
      await new Promise(r => setTimeout(r, 1500)); // Wait for app to stabilize
    } catch (launchError) {
      if (!config.required) {
        console.log(`  ⏭️  Skipping ${config.name} (not installed or failed to launch)`);
        return { passed: 0, failed: 0, skipped: true, name: config.name };
      }
      throw launchError;
    }

    // Test 1: verifyElementExists for known element
    console.log(`  Test 1: verifyElementExists (${config.existsDescription})`);
    try {
      const found = await desktop.verifyElementExists(
        appElement,
        config.existsSelector,
        5000
      );
      if (found) {
        console.log(`    ✅ Found ${config.existsDescription}: role=${found.role()}`);
        passed++;
      } else {
        console.log(`    ❌ Expected to find ${config.existsDescription}`);
        failed++;
      }
    } catch (e) {
      console.log(`    ❌ Error: ${e.message.substring(0, 80)}`);
      failed++;
    }

    // Test 2: verifyElementExists for MenuBar (if applicable)
    if (config.menuBarSelector) {
      console.log(`  Test 2: verifyElementExists (MenuBar)`);
      try {
        const menuBar = await desktop.verifyElementExists(
          appElement,
          config.menuBarSelector,
          3000
        );
        if (menuBar) {
          console.log(`    ✅ Found MenuBar: role=${menuBar.role()}`);
          passed++;
        }
      } catch (e) {
        console.log(`    ❌ MenuBar not found: ${e.message.substring(0, 60)}`);
        failed++;
      }
    }

    // Test 3: verifyElementNotExists for non-existent element
    console.log(`  Test 3: verifyElementNotExists (${config.notExistsDescription})`);
    try {
      await desktop.verifyElementNotExists(
        appElement,
        config.notExistsSelector,
        2000
      );
      console.log(`    ✅ Correctly confirmed ${config.notExistsDescription} does not exist`);
      passed++;
    } catch (e) {
      if (e.message.includes("VERIFICATION_FAILED")) {
        console.log(`    ❌ Element unexpectedly exists`);
      } else {
        console.log(`    ❌ Error: ${e.message.substring(0, 60)}`);
      }
      failed++;
    }

    // Test 4: Scoped locator search
    console.log(`  Test 4: Scoped locator within app window`);
    try {
      const element = await appElement.locator(config.existsSelector).first(3000);
      if (element) {
        console.log(`    ✅ Scoped locator found element: role=${element.role()}`);
        passed++;
      }
    } catch (e) {
      console.log(`    ❌ Scoped locator failed: ${e.message.substring(0, 60)}`);
      failed++;
    }

  } finally {
    // Cleanup
    if (appElement) {
      console.log(`  Closing ${config.name}...`);
      await closeApp(appElement, config.name);
    }
  }

  return { passed, failed, name: config.name };
}

async function runTests() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("Cross-Application Verification Test Suite");
  console.log("Tests SDK verification methods across Windows built-in applications");
  console.log("═══════════════════════════════════════════════════════════════════");

  let totalPassed = 0;
  let totalFailed = 0;
  const results = [];

  for (const config of APP_TESTS) {
    try {
      const result = await testApp(config);
      totalPassed += result.passed;
      totalFailed += result.failed;
      results.push(result);
    } catch (error) {
      console.log(`\n  ❌ ${config.name} test suite crashed: ${error.message}`);
      results.push({ name: config.name, passed: 0, failed: 1, error: error.message });
      totalFailed++;
    }

    // Brief pause between apps
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("Results Summary:");
  console.log("═══════════════════════════════════════════════════════════════════");

  let totalSkipped = 0;
  for (const result of results) {
    if (result.skipped) {
      console.log(`  ⏭️  ${result.name}: SKIPPED (not installed)`);
      totalSkipped++;
    } else {
      const status = result.failed === 0 ? "✅" : "❌";
      console.log(`  ${status} ${result.name}: ${result.passed} passed, ${result.failed} failed`);
    }
  }

  console.log("───────────────────────────────────────────────────────────────────");
  console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
  console.log("═══════════════════════════════════════════════════════════════════");

  process.exit(totalFailed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error("Test suite crashed:", error);
  process.exit(1);
});
