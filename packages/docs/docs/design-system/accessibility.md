# Accessibility Guidelines

The ElizaOS Apple Liquid Glass Design System is built with accessibility as a core principle. Every component and interaction is designed to meet WCAG 2.1 AA standards while maintaining the visual elegance of glassmorphism.

## ♿ Accessibility Principles

### Universal Design Goals

**Inclusive by Default**

- Every user can access content regardless of ability
- Multiple ways to interact with components
- Clear visual and auditory feedback
- Graceful degradation for assistive technologies

**Progressive Enhancement**

- Base functionality works without JavaScript
- Enhanced experiences layer on top
- Fallbacks for visual effects
- Semantic HTML foundation

**Cognitive Accessibility**

- Clear information hierarchy
- Consistent interaction patterns
- Predictable behavior
- Reduced cognitive load

## 🎨 Visual Accessibility

### Color and Contrast

**WCAG AA Compliance**

```css
/* Minimum contrast ratios */
:root {
  /* Text contrast ratios */
  --text-primary-contrast: 7: 1; /* AAA level */
  --text-secondary-contrast: 4.5: 1; /* AA level */
  --text-large-contrast: 3: 1; /* AA large text */

  /* Interactive element contrast */
  --interactive-contrast: 3: 1; /* Minimum for UI components */
  --focus-contrast: 3: 1; /* Focus indicators */
}

/* High contrast text on glass backgrounds */
.glass-text {
  color: var(--glass-text);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  background: linear-gradient(135deg, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.5));
  padding: 4px 8px;
  border-radius: 4px;
}

/* Enhanced contrast mode */
@media (prefers-contrast: high) {
  .glass-container {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: none;
    border: 2px solid #000;
    color: #000;
  }

  .glass-text {
    color: #000;
    text-shadow: none;
    background: #fff;
  }

  .glass-button {
    background: #000;
    color: #fff;
    border: 2px solid #000;
  }

  .glass-button:hover {
    background: #333;
    border-color: #333;
  }
}

/* Dark mode accessibility */
[data-theme='dark'] {
  --glass-text: rgba(255, 255, 255, 0.95);
  --glass-text-secondary: rgba(255, 255, 255, 0.8);
  --glass-border: rgba(255, 255, 255, 0.3);
}
```

### Color Independence

```css
/* Never rely on color alone for information */
.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator--success {
  color: var(--accent-success);
}

.status-indicator--success::before {
  content: '✓';
  font-weight: bold;
}

.status-indicator--warning {
  color: var(--accent-warning);
}

.status-indicator--warning::before {
  content: '⚠';
  font-weight: bold;
}

.status-indicator--error {
  color: var(--accent-danger);
}

.status-indicator--error::before {
  content: '✗';
  font-weight: bold;
}

/* Pattern-based differentiation */
.glass-card--primary {
  border-left: 4px solid var(--accent-primary);
}

.glass-card--secondary {
  border-left: 4px dotted var(--accent-secondary);
}

.glass-card--tertiary {
  border-left: 4px dashed var(--accent-tertiary);
}
```

### Motion and Animation Accessibility

```css
/* Respect reduced motion preferences */
@media (prefers-reduced-motion: reduce) {
  .liquid-animation {
    animation: none !important;
    transition: none !important;
  }

  .liquid-animation--essential {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }

  .glass-hover:hover {
    transform: none !important;
  }

  /* Provide alternative feedback */
  .glass-button:hover {
    background-color: var(--glass-surface-hover);
    border-color: var(--accent-primary);
  }
}

/* Alternative motion indicators */
.motion-alternative {
  position: relative;
}

.motion-alternative::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  opacity: 0;
  background: var(--accent-primary-glass);
  transition: opacity 0.2s ease;
}

.motion-alternative:hover::after {
  opacity: 1;
}
```

## ⌨️ Keyboard Navigation

### Focus Management

**Visible Focus Indicators**

```css
/* Clear focus indicators for all interactive elements */
.glass-interactive:focus-visible {
  outline: 3px solid var(--accent-primary);
  outline-offset: 2px;
  box-shadow: 0 0 0 6px rgba(255, 149, 0, 0.2);
  z-index: var(--depth-floating);
}

/* Enhanced focus for glass components */
.glass-button:focus-visible {
  outline: 3px solid var(--accent-primary);
  outline-offset: 2px;
  background: var(--glass-surface-hover);
  transform: translateY(-2px);
}

.glass-card:focus-visible {
  outline: 3px solid var(--accent-primary);
  outline-offset: 4px;
  transform: translateY(-4px);
}

/* Custom focus styles for complex components */
.glass-modal:focus-visible {
  box-shadow:
    0 0 0 3px var(--accent-primary),
    0 24px 96px rgba(0, 0, 0, 0.3);
}

/* High contrast focus indicators */
@media (prefers-contrast: high) {
  .glass-interactive:focus-visible {
    outline: 4px solid #000;
    outline-offset: 4px;
    box-shadow: 0 0 0 8px #ffff00;
  }
}
```

**Tab Order Management**

```css
/* Logical tab order */
.glass-container {
  /* Ensure proper tab order within containers */
  display: flex;
  flex-direction: column;
}

.glass-card {
  /* Make cards focusable if they contain actions */
  tabindex: 0;
}

.glass-card[aria-disabled='true'] {
  tabindex: -1;
  opacity: 0.5;
  pointer-events: none;
}

/* Skip links for navigation */
.skip-link {
  position: absolute;
  top: -40px;
  left: 6px;
  background: var(--glass-surface);
  color: var(--glass-text);
  padding: 8px;
  text-decoration: none;
  border-radius: 4px;
  z-index: var(--depth-modal);
  transition: top 0.2s ease;
}

.skip-link:focus {
  top: 6px;
}
```

### Keyboard Shortcuts

```javascript
class LiquidKeyboardManager {
  constructor() {
    this.shortcuts = new Map();
    this.modalStack = [];
    this.focusHistory = [];

    this.init();
  }

  init() {
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
    document.addEventListener('focus', this.handleFocus.bind(this), true);
  }

  handleKeyDown(event) {
    // Global shortcuts
    if (event.ctrlKey || event.metaKey) {
      switch (event.key) {
        case '/':
          event.preventDefault();
          this.focusSearch();
          break;
        case 'k':
          event.preventDefault();
          this.openCommandPalette();
          break;
      }
    }

    // Modal management
    if (event.key === 'Escape') {
      this.handleEscape();
    }

    // Tab trapping in modals
    if (event.key === 'Tab' && this.modalStack.length > 0) {
      this.trapFocus(event);
    }
  }

  handleFocus(event) {
    // Track focus history for better UX
    this.focusHistory.unshift(event.target);
    if (this.focusHistory.length > 10) {
      this.focusHistory.pop();
    }
  }

  trapFocus(event) {
    const modal = this.modalStack[this.modalStack.length - 1];
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    if (event.shiftKey) {
      if (document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    }
  }

  openModal(modal) {
    this.modalStack.push(modal);

    // Store current focus
    this.previousFocus = document.activeElement;

    // Focus first element in modal
    const firstFocusable = modal.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    if (firstFocusable) {
      firstFocusable.focus();
    }
  }

  closeModal() {
    if (this.modalStack.length === 0) return;

    this.modalStack.pop();

    // Restore previous focus
    if (this.previousFocus && this.previousFocus.isConnected) {
      this.previousFocus.focus();
    }
  }

  handleEscape() {
    if (this.modalStack.length > 0) {
      this.closeModal();
      return;
    }

    // Clear search or other temporary states
    this.clearTemporaryStates();
  }

  focusSearch() {
    const searchInput = document.querySelector('[data-search-input]');
    if (searchInput) {
      searchInput.focus();
    }
  }

  openCommandPalette() {
    // Implementation for command palette
    console.log('Opening command palette');
  }

  clearTemporaryStates() {
    // Clear any temporary UI states
    document.querySelectorAll('[data-temporary]').forEach((el) => {
      el.remove();
    });
  }
}

// Initialize keyboard manager
const keyboardManager = new LiquidKeyboardManager();
```

## 🔊 Screen Reader Support

### Semantic HTML Structure

```html
<!-- Proper heading hierarchy -->
<main class="glass-container">
  <header class="glass-header">
    <h1 class="glass-text glass-text--heading">ElizaOS Documentation</h1>
    <nav class="glass-nav" aria-label="Main navigation">
      <ul class="glass-nav__list">
        <li><a href="/docs" aria-current="page">Documentation</a></li>
        <li><a href="/api">API Reference</a></li>
        <li><a href="/community">Community</a></li>
      </ul>
    </nav>
  </header>

  <section class="glass-section" aria-labelledby="quick-start">
    <h2 id="quick-start" class="glass-text glass-text--subheading">Quick Start</h2>
    <p class="glass-text glass-text--body">Get started with ElizaOS in minutes.</p>
  </section>
</main>
```

### ARIA Labels and Descriptions

```html
<!-- Interactive glass components with ARIA -->
<div
  class="glass-card"
  role="article"
  aria-labelledby="card-title"
  aria-describedby="card-description"
>
  <h3 id="card-title" class="glass-card__title">Character Builder</h3>
  <p id="card-description" class="glass-card__description">
    Create unique AI personalities with our visual builder
  </p>
  <button class="glass-button glass-button--primary" aria-describedby="card-description">
    Open Builder
  </button>
</div>

<!-- Complex interactive elements -->
<div
  class="glass-slider"
  role="slider"
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow="50"
  aria-label="Opacity level"
  tabindex="0"
>
  <div class="glass-slider__track">
    <div class="glass-slider__thumb" style="left: 50%"></div>
  </div>
</div>

<!-- Status updates -->
<div class="glass-status" role="status" aria-live="polite" aria-atomic="true">
  <span class="visually-hidden">Status: </span>
  Agent is running successfully
</div>

<!-- Error messages -->
<div class="glass-error" role="alert" aria-live="assertive">
  <span class="visually-hidden">Error: </span>
  Failed to connect to server
</div>
```

### Live Regions for Dynamic Content

```javascript
class LiquidLiveRegionManager {
  constructor() {
    this.regions = new Map();
    this.init();
  }

  init() {
    // Create default live regions
    this.createLiveRegion('status', 'polite');
    this.createLiveRegion('alerts', 'assertive');
    this.createLiveRegion('notifications', 'polite');
  }

  createLiveRegion(id, politeness = 'polite') {
    const region = document.createElement('div');
    region.id = `live-region-${id}`;
    region.className = 'visually-hidden';
    region.setAttribute('aria-live', politeness);
    region.setAttribute('aria-atomic', 'true');

    document.body.appendChild(region);
    this.regions.set(id, region);
  }

  announce(message, regionId = 'status') {
    const region = this.regions.get(regionId);
    if (region) {
      // Clear and set to ensure announcement
      region.textContent = '';

      setTimeout(() => {
        region.textContent = message;
      }, 10);

      // Auto-clear after delay to prevent repetition
      setTimeout(() => {
        region.textContent = '';
      }, 5000);
    }
  }

  announceError(message) {
    this.announce(message, 'alerts');
  }

  announceSuccess(message) {
    this.announce(message, 'notifications');
  }
}

// Usage
const liveRegions = new LiquidLiveRegionManager();

// Example usage in components
function submitForm() {
  // ... form submission logic
  liveRegions.announceSuccess('Form submitted successfully');
}

function handleError(error) {
  liveRegions.announceError(`Error: ${error.message}`);
}
```

## 🎯 Component-Specific Accessibility

### Glass Button Accessibility

```html
<button class="glass-button glass-button--primary" type="submit" aria-describedby="button-help">
  <span class="glass-button__icon" aria-hidden="true">▶</span>
  <span class="glass-button__text">Start Agent</span>
  <span class="glass-button__loading visually-hidden" aria-live="polite"> Loading... </span>
</button>
<div id="button-help" class="visually-hidden">
  This will start your AI agent and begin processing
</div>
```

### Glass Modal Accessibility

```html
<div
  class="glass-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="modal-title"
  aria-describedby="modal-description"
>
  <div class="glass-modal__backdrop" aria-hidden="true"></div>
  <div class="glass-modal__content">
    <header class="glass-modal__header">
      <h2 id="modal-title" class="glass-modal__title">Confirm Action</h2>
      <button class="glass-modal__close" aria-label="Close dialog" type="button">
        <span aria-hidden="true">×</span>
      </button>
    </header>
    <div class="glass-modal__body">
      <p id="modal-description">
        Are you sure you want to delete this agent? This action cannot be undone.
      </p>
    </div>
    <footer class="glass-modal__footer">
      <button class="glass-button glass-button--secondary" type="button">Cancel</button>
      <button class="glass-button glass-button--danger" type="button">Delete Agent</button>
    </footer>
  </div>
</div>
```

### Glass Form Controls

```html
<div class="glass-form-group">
  <label for="agent-name" class="glass-label">
    Agent Name
    <span class="glass-label__required" aria-label="required">*</span>
  </label>
  <input
    type="text"
    id="agent-name"
    class="glass-input"
    required
    aria-describedby="agent-name-help agent-name-error"
    aria-invalid="false"
  />
  <div id="agent-name-help" class="glass-help-text">Choose a unique name for your AI agent</div>
  <div id="agent-name-error" class="glass-error-text" aria-live="polite" role="alert">
    <!-- Error messages appear here -->
  </div>
</div>
```

## 🎨 Visual Accessibility Utilities

### Screen Reader Only Content

```css
/* Hide content visually but keep it available to screen readers */
.visually-hidden {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}

/* Show on focus for keyboard users */
.visually-hidden-focusable:focus {
  position: static !important;
  width: auto !important;
  height: auto !important;
  padding: inherit !important;
  margin: inherit !important;
  overflow: visible !important;
  clip: auto !important;
  white-space: inherit !important;
}
```

### Focus Management Utilities

```css
/* Focus ring utilities */
.focus-ring {
  outline: 3px solid var(--accent-primary);
  outline-offset: 2px;
}

.focus-ring--inset {
  outline-offset: -2px;
}

.focus-ring--large {
  outline-width: 4px;
  outline-offset: 4px;
}

/* Focus visible polyfill for older browsers */
.js-focus-visible .focus-ring:focus:not(.focus-visible) {
  outline: none;
}
```

### Text Size and Spacing

```css
/* Respect user font size preferences */
.glass-text {
  font-size: clamp(14px, 1rem, 18px);
  line-height: 1.6;
  letter-spacing: 0.01em;
}

/* Ensure adequate spacing for touch targets */
.glass-button,
.glass-card,
.glass-interactive {
  min-height: 44px; /* iOS accessibility guideline */
  min-width: 44px;
}

/* Responsive text sizing */
@media (max-width: 768px) {
  .glass-text {
    font-size: clamp(16px, 1.1rem, 20px); /* Larger on mobile */
  }
}
```

## 🧪 Accessibility Testing Tools

### Automated Testing

```javascript
class LiquidAccessibilityTester {
  constructor() {
    this.violations = [];
    this.tests = [];
  }

  async runColorContrastTest(element) {
    const computedStyle = window.getComputedStyle(element);
    const backgroundColor = computedStyle.backgroundColor;
    const color = computedStyle.color;

    // Simplified contrast calculation
    const contrast = this.calculateContrast(color, backgroundColor);

    if (contrast < 4.5) {
      this.violations.push({
        type: 'color-contrast',
        element,
        contrast,
        minimum: 4.5,
      });
    }
  }

  testKeyboardNavigation() {
    const focusableElements = document.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    focusableElements.forEach((element) => {
      if (!this.isVisuallyFocusable(element)) {
        this.violations.push({
          type: 'keyboard-navigation',
          element,
          issue: 'No visible focus indicator',
        });
      }
    });
  }

  testARIALabels() {
    const interactiveElements = document.querySelectorAll(
      'button, [role="button"], input, select, textarea'
    );

    interactiveElements.forEach((element) => {
      const label = this.getAccessibleName(element);
      if (!label || label.trim().length === 0) {
        this.violations.push({
          type: 'aria-label',
          element,
          issue: 'Missing accessible name',
        });
      }
    });
  }

  testHeadingStructure() {
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let previousLevel = 0;

    headings.forEach((heading) => {
      const level = parseInt(heading.tagName.charAt(1));

      if (level - previousLevel > 1) {
        this.violations.push({
          type: 'heading-structure',
          element: heading,
          issue: `Heading level ${level} follows ${previousLevel}`,
        });
      }

      previousLevel = level;
    });
  }

  calculateContrast(foreground, background) {
    // Simplified contrast calculation
    // In production, use a proper color contrast library
    return 4.5; // Placeholder
  }

  isVisuallyFocusable(element) {
    const computedStyle = window.getComputedStyle(element);
    return computedStyle.outline !== 'none' || computedStyle.outlineWidth !== '0px';
  }

  getAccessibleName(element) {
    return (
      element.getAttribute('aria-label') ||
      element.getAttribute('aria-labelledby') ||
      element.textContent ||
      element.value ||
      element.alt ||
      element.title
    );
  }

  async runAllTests() {
    this.violations = [];

    // Run all accessibility tests
    document.querySelectorAll('*').forEach((element) => {
      this.runColorContrastTest(element);
    });

    this.testKeyboardNavigation();
    this.testARIALabels();
    this.testHeadingStructure();

    return this.violations;
  }

  generateReport() {
    const groupedViolations = this.violations.reduce((acc, violation) => {
      if (!acc[violation.type]) {
        acc[violation.type] = [];
      }
      acc[violation.type].push(violation);
      return acc;
    }, {});

    return {
      totalViolations: this.violations.length,
      violations: groupedViolations,
      timestamp: new Date().toISOString(),
    };
  }
}

// Usage
const accessibilityTester = new LiquidAccessibilityTester();
accessibilityTester.runAllTests().then(() => {
  const report = accessibilityTester.generateReport();
  console.log('Accessibility Report:', report);
});
```

## 📋 Accessibility Checklist

### Design Phase

- [ ] Color contrast meets WCAG AA standards (4.5:1)
- [ ] Information is not conveyed by color alone
- [ ] Focus indicators are clearly visible
- [ ] Touch targets are at least 44px
- [ ] Animation respects reduced motion preferences

### Development Phase

- [ ] Semantic HTML structure is used
- [ ] Proper heading hierarchy (h1-h6)
- [ ] All interactive elements are keyboard accessible
- [ ] ARIA labels provide context where needed
- [ ] Form controls have associated labels
- [ ] Error messages are announced to screen readers

### Testing Phase

- [ ] Keyboard navigation works throughout
- [ ] Screen reader announces content correctly
- [ ] High contrast mode is supported
- [ ] Zoom to 200% maintains functionality
- [ ] Focus management works in complex components

### Documentation Phase

- [ ] Accessibility features are documented
- [ ] Usage examples include ARIA attributes
- [ ] Keyboard shortcuts are documented
- [ ] Screen reader instructions are provided

---

**Next Steps**: Continue to [Implementation Guide](/docs/design-system/implementation) for step-by-step instructions on integrating the glass design system into your ElizaOS documentation.
