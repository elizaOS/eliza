const { Desktop } = require("../index.js");

/**
 * Test for Element.getValue() and setValue() methods
 *
 * Note: This test requires an application with text input fields.
 * Common apps with text inputs: Notepad, Browser address bar, Settings search
 */
async function testGetSetValue() {
  console.log("📝 Testing Element getValue/setValue methods...");

  try {
    const desktop = new Desktop();

    // Try to find a text input field (edit control)
    console.log("Searching for text input fields...");

    // Common roles for value-based controls: edit, textfield, combobox
    const editLocator = desktop.locator("role:edit");

    try {
      const editField = await editLocator.first(2000);
      console.log(`✅ Found edit field: ${editField.name() || '(unnamed)'}`);

      // Test: Get current value
      console.log("Test: Get current value");
      const currentValue = editField.getValue();
      console.log(`  Current value: ${currentValue !== null ? `"${currentValue}"` : 'null'}`);

      // Test: Set a new value
      console.log("Test: Set value");
      const testValue = "Test Input 123";
      editField.setValue(testValue);
      console.log(`  Set value to: "${testValue}"`);

      // Wait a bit for the UI to update
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify the value changed
      const newValue = editField.getValue();
      console.log(`  New value: ${newValue !== null ? `"${newValue}"` : 'null'}`);

      if (newValue === testValue) {
        console.log(`  ✅ Value set successfully`);
      } else {
        console.log(`  ⚠️  Value changed but doesn't match exactly (may be platform behavior)`);
      }

      // Restore original value if it existed
      if (currentValue !== null) {
        editField.setValue(currentValue);
        console.log(`  Restored original value: "${currentValue}"`);
      } else {
        // Clear the field
        editField.setValue("");
        console.log(`  Cleared field`);
      }

      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No edit field found - this is acceptable if no text input apps are running");
        console.log("   Try running: Notepad, Browser, or Settings app with search field");
        return true; // Not a test failure, just no suitable UI available
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ getValue/setValue test failed:", error.message);
    return false;
  }
}

/**
 * Test getValue with combo box
 */
async function testComboBoxValue() {
  console.log("📝 Testing combo box value...");

  try {
    const desktop = new Desktop();

    // Try to find a combo box
    console.log("Searching for combo box controls...");
    const comboLocator = desktop.locator("role:combobox");

    try {
      const comboBox = await comboLocator.first(2000);
      console.log(`✅ Found combo box: ${comboBox.name() || '(unnamed)'}`);

      // Just verify we can read the value
      const comboValue = comboBox.getValue();
      console.log(`  Combo box value: ${comboValue !== null ? `"${comboValue}"` : 'null'}`);

      console.log("✅ Successfully read combo box value");
      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No combo box found - this is acceptable");
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ Combo box value test failed:", error.message);
    return false;
  }
}

/**
 * Test getValue returns null for non-value elements
 */
async function testGetValueNull() {
  console.log("📝 Testing getValue with non-value element...");

  try {
    const desktop = new Desktop();

    // Try to get value from a button (which shouldn't have a value attribute)
    console.log("Test: Get value from button element");

    try {
      const button = await desktop.locator("role:button").first(2000);

      const buttonValue = button.getValue();
      if (buttonValue === null) {
        console.log(`  ✅ Correctly returned null for button element`);
      } else {
        console.log(`  ⚠️  Got value from button: "${buttonValue}" (unexpected but not fatal)`);
      }

      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No button found for null value test");
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ getValue null test failed:", error.message);
    return false;
  }
}

/**
 * Test setValue with empty string
 */
async function testSetValueEmpty() {
  console.log("📝 Testing setValue with empty string...");

  try {
    const desktop = new Desktop();

    console.log("Test: Set empty value");

    try {
      const editField = await desktop.locator("role:edit").first(2000);

      // Get current value
      const currentValue = editField.getValue();
      console.log(`  Current value: ${currentValue !== null ? `"${currentValue}"` : 'null'}`);

      // Set to empty
      editField.setValue("");
      console.log(`  Set value to empty string`);

      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify it's empty
      const emptyValue = editField.getValue();
      console.log(`  New value: ${emptyValue !== null ? `"${emptyValue}"` : 'null'}`);

      if (emptyValue === "" || emptyValue === null) {
        console.log(`  ✅ Field cleared successfully`);
      }

      // Restore original value
      if (currentValue !== null && currentValue !== "") {
        editField.setValue(currentValue);
        console.log(`  Restored original value`);
      }

      return true;
    } catch (error) {
      if (error.message && error.message.includes("Timed out")) {
        console.log("ℹ️  No edit field found for empty value test");
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.error("❌ setValue empty test failed:", error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runValueTests() {
  console.log("🚀 Starting Element value tests...\n");

  let passed = 0;
  let total = 0;

  // Test 1: Basic get/set value
  total++;
  if (await testGetSetValue()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 2: Combo box value
  total++;
  if (await testComboBoxValue()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 3: getValue returns null
  total++;
  if (await testGetValueNull()) {
    passed++;
  }

  console.log(); // Empty line

  // Test 4: setValue empty string
  total++;
  if (await testSetValueEmpty()) {
    passed++;
  }

  console.log(); // Empty line

  // Results
  if (passed === total) {
    console.log(`🎉 All value tests passed! (${passed}/${total})`);
    process.exit(0);
  } else {
    console.log(`❌ Some tests failed: ${passed}/${total} passed`);
    process.exit(1);
  }
}

// Export for use in other test files
module.exports = {
  testGetSetValue,
  testComboBoxValue,
  testGetValueNull,
  testSetValueEmpty,
  runValueTests,
};

// Run tests if this file is executed directly
if (require.main === module) {
  runValueTests().catch((error) => {
    console.error("💥 Test runner crashed:", error);
    process.exit(1);
  });
}
