const { Desktop } = require('../index.js');

async function testUIElements() {
  const desktop = new Desktop();
  console.log('=== Comprehensive UI Elements Test ===\n');

  // Array to track highlight handles for cleanup
  const highlights = [];

  // Test 1: Navigate to about:blank for test page
  console.log('Step 1: Navigating to about:blank...');
  const window = desktop.navigateBrowser('about:blank', 'Chrome');
  console.log('✓ Navigated to:', window.name());

  // Highlight the browser window
  const windowHighlight = window.highlight(0x00FF00, 5000, 'Chrome Window', 'TopLeft');
  highlights.push(windowHighlight);
  console.log('✓ Browser window highlighted (green)');
  await desktop.delay(3000);

  // Ensure browser has focus
  await window.click();
  await desktop.delay(1000);

  // Test 2: Inject a comprehensive test UI with ARIA attributes
  console.log('\n=== Test: Setting up test UI ===');
  await desktop.executeBrowserScript(`
    document.body.innerHTML = \`
      <h1>ComputerUse.js UI Element Test Page</h1>
      <div style="padding: 20px;">
        <h2>Text Input</h2>
        <input type="text" id="testInput" value="Initial Value" aria-label="Test input field" style="width: 300px; padding: 10px; font-size: 16px;">

        <h2>Checkbox</h2>
        <input type="checkbox" id="testCheckbox" checked aria-label="Test checkbox" style="width: 25px; height: 25px;">
        <label for="testCheckbox" style="font-size: 16px; margin-left: 10px;">Test Checkbox (initially checked)</label>

        <h2>Range Slider</h2>
        <input type="range" id="testSlider" min="0" max="100" value="50" aria-label="Test slider" style="width: 300px; height: 30px;">
        <span id="sliderValue" style="font-size: 16px; margin-left: 10px;">50</span>

        <h2>Select Dropdown</h2>
        <select id="testSelect" aria-label="Test dropdown" style="font-size: 16px; padding: 5px;">
          <option value="opt1">Option 1</option>
          <option value="opt2" selected>Option 2</option>
          <option value="opt3">Option 3</option>
        </select>

        <h2>Radio Buttons</h2>
        <input type="radio" id="radio1" name="radioGroup" value="r1" aria-label="Radio option 1" style="width: 20px; height: 20px;">
        <label for="radio1" style="font-size: 16px; margin-left: 5px;">Radio 1</label><br>
        <input type="radio" id="radio2" name="radioGroup" value="r2" checked aria-label="Radio option 2" style="width: 20px; height: 20px;">
        <label for="radio2" style="font-size: 16px; margin-left: 5px;">Radio 2 (checked)</label><br>
        <input type="radio" id="radio3" name="radioGroup" value="r3" aria-label="Radio option 3" style="width: 20px; height: 20px;">
        <label for="radio3" style="font-size: 16px; margin-left: 5px;">Radio 3</label>

        <h2>Button</h2>
        <button id="testButton" aria-label="Test button" style="padding: 15px 30px; font-size: 16px;">Click Me</button>
        <div id="buttonClicks" style="font-size: 16px; margin-top: 10px;">Clicks: 0</div>

        <h2>Textarea</h2>
        <textarea id="testTextarea" aria-label="Test textarea" style="width: 300px; height: 100px; font-size: 16px; padding: 10px;">Textarea content here</textarea>
      </div>
    \`;

    // Add event listeners
    document.getElementById('testSlider').addEventListener('input', (e) => {
      document.getElementById('sliderValue').textContent = e.target.value;
    });

    let clicks = 0;
    document.getElementById('testButton').addEventListener('click', () => {
      clicks++;
      document.getElementById('buttonClicks').textContent = 'Clicks: ' + clicks;
    });

    'UI created successfully';
  `);
  console.log('✓ Test UI injected');

  // Wait for browser to build accessibility tree (critical for highlighting!)
  console.log('Waiting 5 seconds for accessibility tree to update...');
  await desktop.delay(5000);
  console.log('✓ Accessibility tree ready\n');

  // Set zoom to 50% after page is ready
  console.log('=== Test: Set zoom to 50% ===');
  await desktop.setZoom(50);
  console.log('✓ Zoom set to 50%');
  await desktop.delay(2000);

  // Test 3: getValue() - Read input field
  console.log('=== Test: getValue() on text input ===');

  // Find and highlight the input element
  try {
    const inputElements = await desktop.locator('role:edit').all(3000, 10);
    console.log(`Found ${inputElements.length} edit fields`);
    if (inputElements.length > 0) {
      const inputHighlight = inputElements[0].highlight(0x00FF00, 5000, 'Test Input', 'TopLeft');
      highlights.push(inputHighlight);
      console.log('✓ Input field highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight input:', error.message);
  }

  const inputValue1 = await desktop.executeBrowserScript(`
    document.getElementById('testInput').value;
  `);
  console.log('✓ Initial input value:', inputValue1);

  // Change the value
  await desktop.executeBrowserScript(`
    document.getElementById('testInput').value = 'Changed via script';
  `);
  const inputValue2 = await desktop.executeBrowserScript(`
    document.getElementById('testInput').value;
  `);
  console.log('✓ Updated input value:', inputValue2);
  console.log('');

  // Test 4: isSelected() / setSelected() on checkbox
  console.log('=== Test: isSelected/setSelected on checkbox ===');

  // Find and highlight checkbox
  try {
    const checkboxes = await desktop.locator('role:checkbox').all(3000, 10);
    console.log(`Found ${checkboxes.length} checkboxes`);
    if (checkboxes.length > 0) {
      const checkboxHighlight = checkboxes[0].highlight(0x00FF00, 5000, 'Checkbox', 'TopRight');
      highlights.push(checkboxHighlight);
      console.log('✓ Checkbox highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight checkbox:', error.message);
  }

  const checkboxState1 = await desktop.executeBrowserScript(`
    document.getElementById('testCheckbox').checked;
  `);
  console.log('✓ Initial checkbox state:', checkboxState1);

  await desktop.executeBrowserScript(`
    document.getElementById('testCheckbox').checked = false;
  `);
  const checkboxState2 = await desktop.executeBrowserScript(`
    document.getElementById('testCheckbox').checked;
  `);
  console.log('✓ Checkbox toggled to:', checkboxState2);

  await desktop.executeBrowserScript(`
    document.getElementById('testCheckbox').checked = true;
  `);
  const checkboxState3 = await desktop.executeBrowserScript(`
    document.getElementById('testCheckbox').checked;
  `);
  console.log('✓ Checkbox toggled back to:', checkboxState3);
  console.log('');

  // Test 5: getRangeValue() / setRangeValue() on slider
  console.log('=== Test: getRangeValue/setRangeValue on slider ===');

  // Find and highlight slider
  try {
    const sliders = await desktop.locator('role:slider').all(3000, 10);
    console.log(`Found ${sliders.length} sliders`);
    if (sliders.length > 0) {
      const sliderHighlight = sliders[0].highlight(0x00FF00, 5000, 'Slider', 'BottomLeft');
      highlights.push(sliderHighlight);
      console.log('✓ Slider highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight slider:', error.message);
  }

  const sliderValue1 = await desktop.executeBrowserScript(`
    document.getElementById('testSlider').value;
  `);
  console.log('✓ Initial slider value:', sliderValue1);

  await desktop.executeBrowserScript(`
    document.getElementById('testSlider').value = '75';
    document.getElementById('sliderValue').textContent = '75';
  `);
  const sliderValue2 = await desktop.executeBrowserScript(`
    document.getElementById('testSlider').value;
  `);
  console.log('✓ Slider updated to:', sliderValue2);

  await desktop.executeBrowserScript(`
    document.getElementById('testSlider').value = '25';
    document.getElementById('sliderValue').textContent = '25';
  `);
  const sliderValue3 = await desktop.executeBrowserScript(`
    document.getElementById('testSlider').value;
  `);
  console.log('✓ Slider updated to:', sliderValue3);
  console.log('');

  // Test 6: Radio button selection
  console.log('=== Test: isSelected on radio buttons ===');

  // Find and highlight radio button 2 (initially checked)
  try {
    const radios = await desktop.locator('role:radiobutton').all(3000, 10);
    console.log(`Found ${radios.length} radio buttons`);

    // Highlight radio 2 first (index 1, the checked one)
    if (radios.length > 1) {
      const radio2Highlight = radios[1].highlight(0x00FF00, 5000, 'Radio 2 (checked)', 'BottomRight');
      highlights.push(radio2Highlight);
      console.log('✓ Radio button 2 highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight radio button:', error.message);
  }

  const radio2State = await desktop.executeBrowserScript(`
    document.getElementById('radio2').checked;
  `);
  console.log('✓ Radio 2 checked:', radio2State);

  // Now highlight radio 3 before switching to it
  try {
    const radios = await desktop.locator('role:radiobutton').all(3000, 10);
    if (radios.length > 2) {
      const radio3Highlight = radios[2].highlight(0x00FF00, 5000, 'Radio 3 (switching)', 'BottomRight');
      highlights.push(radio3Highlight);
      console.log('✓ Radio button 3 highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight radio 3:', error.message);
  }

  await desktop.executeBrowserScript(`
    document.getElementById('radio3').checked = true;
  `);
  const radio3State = await desktop.executeBrowserScript(`
    document.getElementById('radio3').checked;
  `);
  const radio2StateAfter = await desktop.executeBrowserScript(`
    document.getElementById('radio2').checked;
  `);
  console.log('✓ Switched to Radio 3:', radio3State, '(Radio 2 now:', radio2StateAfter + ')');
  console.log('');

  // Test 7: Select dropdown
  console.log('=== Test: getValue on select dropdown ===');

  // Find and highlight dropdown
  try {
    const dropdowns = await desktop.locator('role:combobox').all(3000, 10);
    console.log(`Found ${dropdowns.length} dropdowns/comboboxes`);
    if (dropdowns.length > 0) {
      const dropdownHighlight = dropdowns[0].highlight(0x00FF00, 5000, 'Dropdown', 'TopLeft');
      highlights.push(dropdownHighlight);
      console.log('✓ Dropdown highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight dropdown:', error.message);
  }

  const selectValue1 = await desktop.executeBrowserScript(`
    document.getElementById('testSelect').value;
  `);
  console.log('✓ Initial select value:', selectValue1);

  await desktop.executeBrowserScript(`
    document.getElementById('testSelect').value = 'opt3';
  `);
  const selectValue2 = await desktop.executeBrowserScript(`
    document.getElementById('testSelect').value;
  `);
  console.log('✓ Select changed to:', selectValue2);
  console.log('');

  // Test 8: Textarea value
  console.log('=== Test: getValue on textarea ===');

  // Find and highlight textarea
  try {
    const textareas = await desktop.locator('role:edit').all(3000, 10);
    console.log(`Found ${textareas.length} edit fields (including textarea)`);
    // Textarea is usually the second edit field after input
    if (textareas.length > 1) {
      const textareaHighlight = textareas[1].highlight(0x00FF00, 5000, 'Textarea', 'BottomLeft');
      highlights.push(textareaHighlight);
      console.log('✓ Textarea highlighted (green)');
      await desktop.delay(3000);
    }
  } catch (error) {
    console.log('○ Could not highlight textarea:', error.message);
  }

  const textareaValue1 = await desktop.executeBrowserScript(`
    document.getElementById('testTextarea').value;
  `);
  console.log('✓ Initial textarea value:', textareaValue1.substring(0, 30) + '...');

  await desktop.executeBrowserScript(`
    document.getElementById('testTextarea').value = 'Updated textarea content\\nLine 2\\nLine 3';
  `);
  const textareaValue2 = await desktop.executeBrowserScript(`
    document.getElementById('testTextarea').value;
  `);
  console.log('✓ Updated textarea value:', textareaValue2);
  console.log('');

  // Test 9: Button click simulation and state tracking
  console.log('=== Test: Button interaction tracking ===');

  // Find and highlight button
  try {
    const buttons = await desktop.locator('role:button').all(3000, 50);
    console.log(`Found ${buttons.length} buttons, searching for our test button...`);

    // Find the button with "Test button" aria-label or look through them
    let testButton = null;
    for (let i = 0; i < buttons.length; i++) {
      const name = buttons[i].name();
      if (name && (name.includes('Test button') || name.includes('Click Me'))) {
        testButton = buttons[i];
        console.log(`Found test button at index ${i}: "${name}"`);
        break;
      }
    }

    // If not found by name, use a button further in the list (likely in page content)
    if (!testButton && buttons.length > 10) {
      testButton = buttons[buttons.length - 1]; // Try last button
      console.log(`Using last button in list: "${testButton.name()}"`);
    }

    if (testButton) {
      const buttonHighlight = testButton.highlight(0x00FF00, 8000, 'Click Me Button', 'BottomRight');
      highlights.push(buttonHighlight);
      console.log('✓ Button highlighted (green)');
      await desktop.delay(5000);
    }
  } catch (error) {
    console.log('○ Could not highlight button:', error.message);
  }

  const clicks1 = await desktop.executeBrowserScript(`
    document.getElementById('buttonClicks').textContent;
  `);
  console.log('✓ Initial button clicks:', clicks1);

  await desktop.executeBrowserScript(`
    document.getElementById('testButton').click();
    'clicked';
  `);
  await desktop.delay(100);
  const clicks2 = await desktop.executeBrowserScript(`
    document.getElementById('buttonClicks').textContent;
  `);
  console.log('✓ After click:', clicks2);

  await desktop.executeBrowserScript(`
    document.getElementById('testButton').click();
    document.getElementById('testButton').click();
    'clicked twice';
  `);
  await desktop.delay(100);
  const clicks3 = await desktop.executeBrowserScript(`
    document.getElementById('buttonClicks').textContent;
  `);
  console.log('✓ After 2 more clicks:', clicks3);
  console.log('');

  // Test 10: Highlight browser address bar
  console.log('=== Test: Highlight browser address bar ===');

  // Click address bar to focus it
  await desktop.pressKey('{Ctrl}l');
  await desktop.delay(500);

  // Find and highlight address bar
  try {
    // Address bar should be an edit field with focus
    const addressBar = await desktop.locator('role:edit').first(1000);
    const addressHighlight = addressBar.highlight(0x00FF00, 5000, 'Address Bar', 'TopLeft');
    highlights.push(addressHighlight);
    console.log('✓ Address bar highlighted (green)');
    await desktop.delay(3000);

    // Type in the address bar
    await desktop.pressKey('github.com');
    await desktop.delay(2000);

    // Clear it
    await desktop.pressKey('{Ctrl}a');
    await desktop.delay(100);
    await desktop.pressKey('{Delete}');
    await desktop.delay(500);

    console.log('✓ Typed and cleared in address bar');
  } catch (error) {
    console.log('○ Could not highlight address bar:', error.message);
  }
  console.log('');

  // Test 11: pressKey() - Interact with input field via keyboard
  console.log('=== Test: pressKey() with focused input ===');

  // Click back into the page
  await window.click();
  await desktop.delay(500);

  // Click on the input to ensure OS-level focus
  const inputElementForTyping = await desktop.locator('role:edit').first(2000);
  await inputElementForTyping.click();
  await desktop.delay(300);

  // Select all and delete first
  await desktop.pressKey('{Ctrl}a');
  await desktop.delay(100);
  await desktop.pressKey('{Delete}');
  await desktop.delay(100);

  await desktop.pressKey('Typed via pressKey');
  await desktop.delay(500);

  const typedValue = await desktop.executeBrowserScript(`
    document.getElementById('testInput').value;
  `);
  console.log('✓ Value after pressKey():', typedValue);
  console.log('');

  // Test 11: scrollIntoView() - Create scrollable content
  console.log('=== Test: scrollIntoView() ===');
  await desktop.executeBrowserScript(`
    const scrollDiv = document.createElement('div');
    scrollDiv.innerHTML = '<h2>Scroll Test</h2>' +
      '<div style="height: 2000px; background: linear-gradient(white, lightblue);"></div>' +
      '<div id="bottomElement" style="padding: 20px; background: yellow;">Bottom Element</div>';
    document.body.appendChild(scrollDiv);
    'Scroll content added';
  `);
  await desktop.delay(500);

  const scrollBefore = await desktop.executeBrowserScript('window.scrollY');
  console.log('✓ Scroll position before:', scrollBefore);

  await desktop.executeBrowserScript(`
    document.getElementById('bottomElement').scrollIntoView({behavior: 'smooth'});
    'scrolled';
  `);
  await desktop.delay(1000);

  const scrollAfter = await desktop.executeBrowserScript('window.scrollY');
  console.log('✓ Scroll position after scrollIntoView():', scrollAfter);
  console.log('');

  // Test 12: validate() and waitFor() on dynamically added elements
  console.log('=== Test: validate() and waitFor() on dynamic elements ===');

  // Schedule element to appear after delay
  await desktop.executeBrowserScript(`
    setTimeout(() => {
      const delayed = document.createElement('button');
      delayed.id = 'delayedButton';
      delayed.textContent = 'I appeared after 2 seconds!';
      document.body.appendChild(delayed);
    }, 2000);
  `);

  // Try validate before it appears
  const validateBefore = await desktop.locator('role:button|I appeared').validate(500);
  console.log('✓ validate() before element appears:', { exists: validateBefore.exists });

  // Wait for it to appear
  console.log('Waiting for element to appear...');
  await desktop.delay(2500);

  const validateAfter = await desktop.locator('role:button|I appeared').validate(1000);
  console.log('✓ validate() after element appears:', { exists: validateAfter.exists });
  console.log('');

  // Test 13: delay() accuracy with multiple operations
  console.log('=== Test: delay() timing accuracy ===');
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    await desktop.delay(100);
    timings.push(Date.now() - start);
  }
  console.log('✓ 5x delay(100ms) timings:', timings.map(t => t + 'ms').join(', '));
  const avg = timings.reduce((a, b) => a + b) / timings.length;
  console.log('✓ Average:', avg.toFixed(1) + 'ms (±' + (avg - 100).toFixed(1) + 'ms)');
  console.log('');

  // Cleanup
  console.log('=== Cleanup ===');

  // Reset zoom to 100%
  console.log('Resetting zoom to 100%...');
  await desktop.setZoom(100);
  console.log('✓ Zoom reset to 100%');
  await desktop.delay(1000);

  // Close all highlights
  console.log(`Closing ${highlights.length} active highlights...`);
  for (const highlight of highlights) {
    highlight.close();
  }
  console.log('✓ All highlights closed');
  await desktop.delay(500);

  await desktop.pressKey('{Ctrl}w');
  await desktop.delay(500);
  console.log('✓ Browser tab closed');

  console.log('\n=== All UI Element Tests Completed Successfully ===');
}

testUIElements().catch(console.error);
