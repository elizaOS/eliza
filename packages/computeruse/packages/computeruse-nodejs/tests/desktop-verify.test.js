const { Desktop } = require("../index.js");

/**
 * Test for Desktop.verifyElementExists() and Desktop.verifyElementNotExists() methods
 * These tests verify the verification methods work correctly with window-scoped searches
 */

async function testVerifyElementExists() {
  console.log("🔍 Testing Desktop.verifyElementExists()...");
  const desktop = new Desktop();

  // Open Notepad for testing
  console.log("  Opening Notepad...");
  const notepad = await desktop.openApplication("notepad.exe");
  await new Promise(r => setTimeout(r, 1000));

  try {
    // Test 1: Find an element that exists (Document/text editor)
    console.log("  Test 1: Verify existing element (Document)");
    const textEditor = await desktop.verifyElementExists(
      notepad,
      "role:Document || role:Edit",
      5000
    );

    if (!textEditor) {
      throw new Error("Expected to find text editor element");
    }
    console.log(`  ✅ Found: role=${textEditor.role()}, name=${textEditor.name()}`);

    // Test 2: Find MenuBar (tests menubar role mapping)
    console.log("  Test 2: Verify MenuBar exists");
    const menuBar = await desktop.verifyElementExists(
      notepad,
      "role:MenuBar",
      5000
    );

    if (!menuBar) {
      throw new Error("Expected to find MenuBar element");
    }
    console.log(`  ✅ Found: role=${menuBar.role()}`);

    // Test 3: Non-existent element should throw
    console.log("  Test 3: Verify non-existent element throws error");
    let threwError = false;
    try {
      await desktop.verifyElementExists(
        notepad,
        "role:Button && name:NonExistentButton12345",
        2000
      );
    } catch (e) {
      threwError = true;
      console.log(`  ✅ Correctly threw error for non-existent element`);
    }

    if (!threwError) {
      throw new Error("Expected verifyElementExists to throw for non-existent element");
    }

    return true;
  } finally {
    // Cleanup
    console.log("  Closing Notepad...");
    try {
      await notepad.pressKey("Alt+F4");
      await new Promise(r => setTimeout(r, 500));
      const dontSave = await notepad.locator("role:Button && name:Don\\'t Save").first();
      await dontSave.click();
    } catch {
      // No save dialog
    }
  }
}

async function testVerifyElementNotExists() {
  console.log("\n🔍 Testing Desktop.verifyElementNotExists()...");
  const desktop = new Desktop();

  // Open Notepad for testing
  console.log("  Opening Notepad...");
  const notepad = await desktop.openApplication("notepad.exe");
  await new Promise(r => setTimeout(r, 1000));

  try {
    // Test 1: Verify non-existent element passes
    console.log("  Test 1: Verify non-existent element (Save As dialog)");
    await desktop.verifyElementNotExists(
      notepad,
      "role:Window && name:Save As",
      2000
    );
    console.log("  ✅ Correctly confirmed 'Save As' dialog does not exist");

    // Test 2: Verify existing element throws
    console.log("  Test 2: Verify existing element (MenuBar) throws error");
    let threwError = false;
    try {
      await desktop.verifyElementNotExists(
        notepad,
        "role:MenuBar",
        2000
      );
    } catch (e) {
      threwError = true;
      if (e.message.includes("VERIFICATION_FAILED")) {
        console.log("  ✅ Correctly threw VERIFICATION_FAILED for existing element");
      } else {
        throw new Error(`Expected VERIFICATION_FAILED error, got: ${e.message}`);
      }
    }

    if (!threwError) {
      throw new Error("Expected verifyElementNotExists to throw for existing element");
    }

    return true;
  } finally {
    // Cleanup
    console.log("  Closing Notepad...");
    try {
      await notepad.pressKey("Alt+F4");
      await new Promise(r => setTimeout(r, 500));
      const dontSave = await notepad.locator("role:Button && name:Don\\'t Save").first();
      await dontSave.click();
    } catch {
      // No save dialog
    }
  }
}

async function runTests() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Desktop Verification Methods Test Suite");
  console.log("═══════════════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;

  try {
    await testVerifyElementExists();
    passed++;
    console.log("\n✅ testVerifyElementExists PASSED\n");
  } catch (error) {
    failed++;
    console.error("\n❌ testVerifyElementExists FAILED:", error.message, "\n");
  }

  try {
    await testVerifyElementNotExists();
    passed++;
    console.log("\n✅ testVerifyElementNotExists PASSED\n");
  } catch (error) {
    failed++;
    console.error("\n❌ testVerifyElementNotExists FAILED:", error.message, "\n");
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error("Test suite crashed:", error);
  process.exit(1);
});
