# Glass Component Library

The ElizaOS Glass Component Library provides a comprehensive set of reusable components built with the Apple Liquid Glass design principles. Each component is optimized for performance, accessibility, and visual excellence.

## 🏗️ Layout Components

### GlassContainer

The foundational container component that provides the base glass effect for content areas.

**Properties:**

- `variant`: `'surface' | 'raised' | 'floating' | 'modal'`
- `blur`: `number` (default: 20)
- `opacity`: `number` (default: 0.8)
- `rounded`: `boolean` (default: true)

**CSS Implementation:**

```css
.glass-container {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px var(--glass-shadow);
  position: relative;
  overflow: hidden;
}

.glass-container::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
}

/* Variants */
.glass-container--surface {
  z-index: var(--depth-surface);
  box-shadow: 0 4px 16px var(--glass-shadow);
}

.glass-container--raised {
  z-index: var(--depth-raised);
  box-shadow: 0 8px 32px var(--glass-shadow);
  transform: translateZ(0);
}

.glass-container--floating {
  z-index: var(--depth-floating);
  box-shadow: 0 16px 64px var(--glass-shadow);
  transform: translateY(-4px);
}

.glass-container--modal {
  z-index: var(--depth-modal);
  box-shadow: 0 24px 96px rgba(0, 0, 0, 0.3);
  border: 2px solid var(--glass-border);
}
```

**Usage Example:**

```html
<div class="glass-container glass-container--floating">
  <h2>Documentation Section</h2>
  <p>Content with beautiful glass effect</p>
</div>
```

### FloatingPanel

A specialized container for sidebar panels and navigation areas.

**Features:**

- Sticky positioning with smooth scroll behavior
- Automatic height adjustment
- Collapsible with liquid animations

**CSS Implementation:**

```css
.floating-panel {
  position: sticky;
  top: 80px;
  height: calc(100vh - 100px);
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border-radius: 16px;
  overflow: hidden;
  transition: all var(--liquid-duration-medium) var(--liquid-easing);
}

.floating-panel__header {
  padding: 20px;
  border-bottom: 1px solid var(--glass-border);
  background: linear-gradient(135deg, var(--glass-surface), transparent);
}

.floating-panel__content {
  padding: 20px;
  height: calc(100% - 80px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--glass-border) transparent;
}

.floating-panel__content::-webkit-scrollbar {
  width: 6px;
}

.floating-panel__content::-webkit-scrollbar-track {
  background: transparent;
}

.floating-panel__content::-webkit-scrollbar-thumb {
  background: var(--glass-border);
  border-radius: 3px;
}

/* Collapsed State */
.floating-panel--collapsed {
  width: 60px;
  overflow: hidden;
}

.floating-panel--collapsed .floating-panel__content {
  opacity: 0;
  transform: translateX(-20px);
}
```

### NavigationGlass

A glassmorphic navigation component with liquid hover effects.

**Features:**

- Responsive navigation with mobile-first approach
- Smooth transitions between states
- Breadcrumb integration
- Search integration

**CSS Implementation:**

```css
.navigation-glass {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--depth-floating);
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border-bottom: 1px solid var(--glass-border);
  padding: 16px 0;
  transition: all var(--liquid-duration-medium) var(--liquid-easing);
}

.navigation-glass__container {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.navigation-glass__logo {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  font-weight: 600;
  color: var(--glass-text);
  text-decoration: none;
}

.navigation-glass__logo img {
  width: 32px;
  height: 32px;
  border-radius: 8px;
}

.navigation-glass__menu {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.navigation-glass__item {
  position: relative;
}

.navigation-glass__link {
  display: block;
  padding: 8px 16px;
  color: var(--glass-text-secondary);
  text-decoration: none;
  border-radius: 8px;
  transition: all var(--liquid-duration-fast) var(--liquid-easing);
  position: relative;
  overflow: hidden;
}

.navigation-glass__link::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
  transition: left var(--liquid-duration-medium) var(--liquid-easing);
}

.navigation-glass__link:hover {
  color: var(--glass-text);
  background: var(--glass-surface-hover);
  transform: translateY(-1px);
}

.navigation-glass__link:hover::before {
  left: 100%;
}

.navigation-glass__link--active {
  color: var(--accent-primary);
  background: var(--accent-primary-glass);
  font-weight: 500;
}
```

## 🎛️ Interactive Components

### GlassButton

A versatile button component with liquid hover effects and haptic feedback.

**Variants:**

- `primary`: Main call-to-action button
- `secondary`: Secondary actions
- `ghost`: Minimal style for subtle actions
- `danger`: Destructive actions

**CSS Implementation:**

```css
.glass-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 24px;
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  color: var(--glass-text);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all var(--liquid-duration-fast) var(--liquid-easing);
  min-height: 44px;
  touch-action: manipulation;
  overflow: hidden;
}

.glass-button::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
  opacity: 0;
  transition: opacity var(--liquid-duration-fast) var(--liquid-easing);
}

.glass-button:hover::before {
  opacity: 1;
}

.glass-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 48px var(--glass-shadow);
  border-color: var(--accent-primary);
}

.glass-button:active {
  transform: translateY(0);
  box-shadow: 0 4px 16px var(--glass-shadow);
}

/* Variants */
.glass-button--primary {
  background: linear-gradient(135deg, var(--accent-primary), rgba(255, 149, 0, 0.8));
  color: white;
  border-color: var(--accent-primary);
  box-shadow: 0 8px 32px rgba(255, 149, 0, 0.3);
}

.glass-button--secondary {
  background: var(--glass-surface);
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.glass-button--ghost {
  background: transparent;
  border-color: transparent;
  backdrop-filter: none;
}

.glass-button--danger {
  background: linear-gradient(135deg, var(--accent-danger), rgba(255, 59, 48, 0.8));
  color: white;
  border-color: var(--accent-danger);
}

/* Loading State */
.glass-button--loading {
  pointer-events: none;
  position: relative;
}

.glass-button--loading::after {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top: 2px solid currentColor;
  border-radius: 50%;
  animation: glass-button-spin 1s linear infinite;
}

@keyframes glass-button-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
```

### GlassCard

A content card with glassmorphic styling and interactive hover effects.

**Features:**

- Hover animations with depth changes
- Optional image headers
- Flexible content layouts
- Action button integration

**CSS Implementation:**

```css
.glass-card {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  overflow: hidden;
  transition: all var(--liquid-duration-medium) var(--liquid-easing);
  position: relative;
  cursor: pointer;
}

.glass-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
}

.glass-card:hover {
  transform: translateY(-8px) scale(1.02);
  box-shadow: 0 20px 80px rgba(0, 0, 0, 0.2);
  border-color: var(--accent-primary);
}

.glass-card__header {
  position: relative;
  overflow: hidden;
}

.glass-card__image {
  width: 100%;
  height: 200px;
  object-fit: cover;
  transition: transform var(--liquid-duration-slow) var(--liquid-easing);
}

.glass-card:hover .glass-card__image {
  transform: scale(1.05);
}

.glass-card__content {
  padding: 24px;
}

.glass-card__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--glass-text);
  margin: 0 0 8px 0;
  line-height: 1.3;
}

.glass-card__description {
  color: var(--glass-text-secondary);
  line-height: 1.5;
  margin: 0 0 16px 0;
}

.glass-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-top: 1px solid var(--glass-border);
  background: linear-gradient(135deg, var(--glass-surface), transparent);
}

.glass-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--glass-text-secondary);
  font-size: 12px;
}

.glass-card__actions {
  display: flex;
  gap: 8px;
}
```

### GlassModal

A modal dialog component with glassmorphic backdrop and smooth animations.

**Features:**

- Backdrop blur effect
- Smooth entrance/exit animations
- Keyboard navigation support
- Focus management

**CSS Implementation:**

```css
.glass-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--depth-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  opacity: 0;
  visibility: hidden;
  transition: all var(--liquid-duration-medium) var(--liquid-easing);
}

.glass-modal--open {
  opacity: 1;
  visibility: visible;
}

.glass-modal__backdrop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(8px);
  cursor: pointer;
}

.glass-modal__content {
  position: relative;
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: 0 24px 96px rgba(0, 0, 0, 0.3);
  max-width: 600px;
  width: 100%;
  max-height: calc(100vh - 40px);
  overflow: hidden;
  transform: scale(0.9) translateY(20px);
  transition: transform var(--liquid-duration-medium) var(--liquid-bounce);
}

.glass-modal--open .glass-modal__content {
  transform: scale(1) translateY(0);
}

.glass-modal__header {
  padding: 24px 24px 16px;
  border-bottom: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.glass-modal__title {
  font-size: 20px;
  font-weight: 600;
  color: var(--glass-text);
  margin: 0;
}

.glass-modal__close {
  background: none;
  border: none;
  color: var(--glass-text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition: all var(--liquid-duration-fast) var(--liquid-easing);
}

.glass-modal__close:hover {
  background: var(--glass-surface-hover);
  color: var(--glass-text);
}

.glass-modal__body {
  padding: 24px;
  max-height: 60vh;
  overflow-y: auto;
}

.glass-modal__footer {
  padding: 16px 24px 24px;
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
```

## 📝 Content Components

### GlassText

Enhanced text components with glassmorphic styling and improved readability.

**Variants:**

- `heading`: For section headings
- `subheading`: For subsection titles
- `body`: For paragraph text
- `caption`: For small text and labels

**CSS Implementation:**

```css
.glass-text {
  color: var(--glass-text);
  line-height: 1.6;
  margin: 0;
}

.glass-text--heading {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  margin-bottom: 16px;
  background: linear-gradient(135deg, var(--glass-text), var(--accent-primary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.glass-text--subheading {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  margin-bottom: 12px;
  color: var(--glass-text);
}

.glass-text--body {
  font-size: 16px;
  line-height: 1.6;
  margin-bottom: 16px;
  color: var(--glass-text-secondary);
}

.glass-text--caption {
  font-size: 12px;
  font-weight: 500;
  color: var(--glass-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Enhanced readability */
.glass-text--enhanced {
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
  padding: 16px;
  border-radius: 8px;
  backdrop-filter: blur(10px);
}
```

### GlassCode

Code blocks with glassmorphic styling and syntax highlighting integration.

**Features:**

- Syntax highlighting support
- Copy to clipboard functionality
- Language indicators
- Line numbers

**CSS Implementation:**

```css
.glass-code {
  position: relative;
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
  margin: 24px 0;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace;
}

.glass-code__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--glass-border);
  background: linear-gradient(135deg, var(--glass-surface), transparent);
}

.glass-code__language {
  font-size: 12px;
  color: var(--glass-text-secondary);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.glass-code__copy {
  background: none;
  border: none;
  color: var(--glass-text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  transition: all var(--liquid-duration-fast) var(--liquid-easing);
}

.glass-code__copy:hover {
  background: var(--glass-surface-hover);
  color: var(--glass-text);
}

.glass-code__content {
  padding: 20px;
  overflow-x: auto;
  font-size: 14px;
  line-height: 1.5;
}

.glass-code__content pre {
  margin: 0;
  background: none;
  padding: 0;
  overflow: visible;
}

.glass-code__content code {
  background: none;
  padding: 0;
  border-radius: 0;
  color: var(--glass-text);
}

/* Line numbers */
.glass-code--line-numbers .glass-code__content {
  padding-left: 60px;
  position: relative;
}

.glass-code--line-numbers .glass-code__content::before {
  content: counter(line-numbering);
  counter-increment: line-numbering;
  position: absolute;
  left: 0;
  width: 40px;
  text-align: right;
  padding-right: 16px;
  color: var(--glass-text-secondary);
  font-size: 12px;
  top: 0;
  bottom: 0;
  border-right: 1px solid var(--glass-border);
  background: linear-gradient(135deg, var(--glass-surface), transparent);
}
```

### GlassTable

Data tables with glassmorphic styling and enhanced readability.

**Features:**

- Responsive design with horizontal scrolling
- Sortable columns
- Hover effects on rows
- Sticky headers

**CSS Implementation:**

```css
.glass-table {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
  margin: 24px 0;
  position: relative;
}

.glass-table__wrapper {
  overflow-x: auto;
  max-width: 100%;
}

.glass-table__content {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.glass-table__header {
  background: linear-gradient(135deg, var(--glass-surface), rgba(255, 255, 255, 0.05));
  border-bottom: 2px solid var(--glass-border);
  position: sticky;
  top: 0;
  z-index: 1;
}

.glass-table__header th {
  padding: 16px 20px;
  text-align: left;
  font-weight: 600;
  color: var(--glass-text);
  white-space: nowrap;
  position: relative;
}

.glass-table__header th::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent-primary), transparent);
}

.glass-table__row {
  border-bottom: 1px solid var(--glass-border);
  transition: background-color var(--liquid-duration-fast) var(--liquid-easing);
}

.glass-table__row:hover {
  background: var(--glass-surface-hover);
}

.glass-table__row:last-child {
  border-bottom: none;
}

.glass-table__cell {
  padding: 12px 20px;
  color: var(--glass-text-secondary);
  vertical-align: top;
}

.glass-table__cell--primary {
  color: var(--glass-text);
  font-weight: 500;
}

.glass-table__cell--accent {
  color: var(--accent-primary);
}

/* Sortable columns */
.glass-table__sort-button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  font-weight: inherit;
  transition: color var(--liquid-duration-fast) var(--liquid-easing);
}

.glass-table__sort-button:hover {
  color: var(--accent-primary);
}

.glass-table__sort-icon {
  font-size: 12px;
  opacity: 0.5;
  transition: opacity var(--liquid-duration-fast) var(--liquid-easing);
}

.glass-table__sort-button--active .glass-table__sort-icon {
  opacity: 1;
  color: var(--accent-primary);
}
```

## 🎞️ Animation Components

### LiquidTransition

Smooth transitions between content states with liquid motion effects.

**CSS Implementation:**

```css
.liquid-transition {
  position: relative;
  overflow: hidden;
}

.liquid-transition__content {
  transition: all var(--liquid-duration-medium) var(--liquid-easing);
}

.liquid-transition__content--entering {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

.liquid-transition__content--entered {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.liquid-transition__content--exiting {
  opacity: 0;
  transform: translateY(-20px) scale(1.05);
}

/* Liquid morphing effect */
.liquid-transition--morph {
  position: relative;
}

.liquid-transition--morph::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--glass-surface);
  border-radius: 50%;
  transform: scale(0);
  transition: transform var(--liquid-duration-slow) var(--liquid-bounce);
  z-index: -1;
}

.liquid-transition--morph.liquid-transition--active::before {
  transform: scale(1.5);
  border-radius: 12px;
}
```

### FloatingElement

Elements that float and respond to user interaction with subtle animations.

**CSS Implementation:**

```css
.floating-element {
  position: relative;
  transition: transform var(--liquid-duration-medium) var(--liquid-easing);
  animation: float-gentle 6s ease-in-out infinite;
}

@keyframes float-gentle {
  0%,
  100% {
    transform: translateY(0px);
  }
  50% {
    transform: translateY(-8px);
  }
}

.floating-element:hover {
  animation-play-state: paused;
  transform: translateY(-12px) scale(1.05);
}

.floating-element--fast {
  animation-duration: 3s;
}

.floating-element--slow {
  animation-duration: 12s;
}

/* Magnetic effect */
.floating-element--magnetic {
  transition: transform var(--liquid-duration-fast) var(--liquid-easing);
}

.floating-element--magnetic:hover {
  transform: translateY(-8px) scale(1.02);
}
```

## 📱 Usage Examples

### Complete Page Layout

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ElizaOS Glass Design System</title>
    <link rel="stylesheet" href="glass-components.css" />
  </head>
  <body>
    <!-- Navigation -->
    <nav class="navigation-glass">
      <div class="navigation-glass__container">
        <a href="#" class="navigation-glass__logo">
          <img src="logo.png" alt="ElizaOS" />
          ElizaOS
        </a>
        <ul class="navigation-glass__menu">
          <li class="navigation-glass__item">
            <a href="#" class="navigation-glass__link navigation-glass__link--active">Docs</a>
          </li>
          <li class="navigation-glass__item">
            <a href="#" class="navigation-glass__link">API</a>
          </li>
          <li class="navigation-glass__item">
            <a href="#" class="navigation-glass__link">Community</a>
          </li>
        </ul>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="main-content">
      <div class="glass-container glass-container--floating">
        <h1 class="glass-text glass-text--heading">Welcome to ElizaOS</h1>
        <p class="glass-text glass-text--body">
          Build powerful AI agents with our glassmorphic design system.
        </p>

        <div class="glass-card">
          <div class="glass-card__content">
            <h2 class="glass-card__title">Quick Start Guide</h2>
            <p class="glass-card__description">Get started with ElizaOS in just a few minutes.</p>
          </div>
          <div class="glass-card__footer">
            <div class="glass-card__meta">
              <span>5 min read</span>
            </div>
            <div class="glass-card__actions">
              <button class="glass-button glass-button--primary">Get Started</button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <script src="glass-components.js"></script>
  </body>
</html>
```

### Interactive Component Example

```javascript
// Initialize glass components
document.addEventListener('DOMContentLoaded', () => {
  // Initialize floating elements
  const floatingElements = document.querySelectorAll('.floating-element');
  floatingElements.forEach((element) => {
    new FloatingElement(element);
  });

  // Initialize glass cards
  const glassCards = document.querySelectorAll('.glass-card');
  glassCards.forEach((card) => {
    new GlassCard(card);
  });

  // Initialize modals
  const modals = document.querySelectorAll('.glass-modal');
  modals.forEach((modal) => {
    new GlassModal(modal);
  });
});

class GlassCard {
  constructor(element) {
    this.element = element;
    this.init();
  }

  init() {
    this.element.addEventListener('mouseenter', this.handleMouseEnter.bind(this));
    this.element.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
    this.element.addEventListener('click', this.handleClick.bind(this));
  }

  handleMouseEnter() {
    this.element.style.transform = 'translateY(-8px) scale(1.02)';
  }

  handleMouseLeave() {
    this.element.style.transform = 'translateY(0) scale(1)';
  }

  handleClick() {
    // Add click animation
    this.element.style.transform = 'translateY(-4px) scale(0.98)';
    setTimeout(() => {
      this.element.style.transform = 'translateY(-8px) scale(1.02)';
    }, 100);
  }
}
```

## 🎯 Best Practices

### Performance Optimization

1. **Use transform and opacity for animations** - These properties are GPU-accelerated
2. **Implement will-change property** - For elements that will be animated
3. **Use containment** - CSS containment for better performance
4. **Optimize backdrop-filter** - Use sparingly and consider fallbacks

### Accessibility Guidelines

1. **Maintain contrast ratios** - Ensure text remains readable on glass backgrounds
2. **Provide focus indicators** - Clear visual feedback for keyboard navigation
3. **Support reduced motion** - Disable animations for users who prefer reduced motion
4. **Use semantic HTML** - Ensure proper document structure

### Implementation Tips

1. **Start with the base glass classes** - Build upon the foundation
2. **Use CSS custom properties** - For easy theming and customization
3. **Test on various devices** - Ensure performance across different hardware
4. **Progressive enhancement** - Provide fallbacks for older browsers

---

**Next Steps**: Continue to [Animation Guidelines](/docs/design-system/animations) for detailed animation specifications and implementation examples.
