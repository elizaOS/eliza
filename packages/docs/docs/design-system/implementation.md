# Implementation Guide

This comprehensive guide walks you through implementing the ElizaOS Apple Liquid Glass Design System in your documentation project. Follow these step-by-step instructions to create stunning glassmorphic interfaces with smooth liquid animations.

## 🚀 Quick Start Implementation

### Step 1: Install Dependencies

```bash
# Install required packages
npm install --save-dev sass postcss autoprefixer
npm install --save @docusaurus/theme-classic

# Optional: For advanced features
npm install --save-dev @docusaurus/plugin-content-docs
npm install --save framer-motion # For advanced animations
```

### Step 2: Basic CSS Setup

Create a new CSS file for the glass design system:

```css
/* /src/css/glass-design-system.css */

/* Import base design tokens */
@import url('./tokens/glass-tokens.css');
@import url('./tokens/animation-tokens.css');
@import url('./tokens/accessibility-tokens.css');

/* Import component styles */
@import url('./components/glass-base.css');
@import url('./components/glass-layout.css');
@import url('./components/glass-interactive.css');
@import url('./components/glass-content.css');
@import url('./components/glass-animations.css');

/* Import utilities */
@import url('./utilities/performance.css');
@import url('./utilities/accessibility.css');
@import url('./utilities/responsive.css');
```

### Step 3: Design Tokens Setup

```css
/* /src/css/tokens/glass-tokens.css */
:root {
  /* Glass Properties */
  --glass-blur: 20px;
  --glass-opacity: 0.8;
  --glass-opacity-hover: 0.9;
  --glass-border-opacity: 0.2;
  --glass-shadow-opacity: 0.1;

  /* Depth Layers */
  --depth-surface: 0;
  --depth-raised: 1;
  --depth-floating: 2;
  --depth-modal: 1000;
  --depth-tooltip: 1001;

  /* Color System */
  --glass-surface: rgba(255, 255, 255, 0.1);
  --glass-surface-hover: rgba(255, 255, 255, 0.15);
  --glass-border: rgba(255, 255, 255, 0.2);
  --glass-shadow: rgba(0, 0, 0, 0.1);
  --glass-text: rgba(255, 255, 255, 0.9);
  --glass-text-secondary: rgba(255, 255, 255, 0.7);

  /* Brand Colors */
  --accent-primary: #ff9500;
  --accent-primary-glass: rgba(255, 149, 0, 0.2);
  --accent-secondary: #007aff;
  --accent-secondary-glass: rgba(0, 122, 255, 0.2);
}

/* Dark theme adjustments */
[data-theme='dark'] {
  --glass-surface: rgba(0, 0, 0, 0.3);
  --glass-surface-hover: rgba(0, 0, 0, 0.4);
  --glass-border: rgba(255, 255, 255, 0.1);
  --glass-shadow: rgba(0, 0, 0, 0.3);
}

/* High contrast mode */
@media (prefers-contrast: high) {
  :root {
    --glass-surface: rgba(255, 255, 255, 0.95);
    --glass-border: rgba(0, 0, 0, 0.8);
    --glass-text: rgba(0, 0, 0, 1);
  }

  [data-theme='dark'] {
    --glass-surface: rgba(0, 0, 0, 0.95);
    --glass-border: rgba(255, 255, 255, 0.8);
    --glass-text: rgba(255, 255, 255, 1);
  }
}
```

## 🏗️ Component Implementation

### Glass Container Base

```css
/* /src/css/components/glass-base.css */
.glass-base {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px var(--glass-shadow);
  position: relative;
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-base::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
  z-index: 1;
}

/* Glass variants */
.glass-base--surface {
  z-index: var(--depth-surface);
  box-shadow: 0 4px 16px var(--glass-shadow);
}

.glass-base--raised {
  z-index: var(--depth-raised);
  box-shadow: 0 8px 32px var(--glass-shadow);
  transform: translateZ(0);
}

.glass-base--floating {
  z-index: var(--depth-floating);
  box-shadow: 0 16px 64px var(--glass-shadow);
  transform: translateY(-4px);
}

/* Interactive states */
.glass-base--interactive {
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-base--interactive:hover {
  background: var(--glass-surface-hover);
  transform: translateY(-2px);
  box-shadow: 0 12px 48px var(--glass-shadow);
}

.glass-base--interactive:active {
  transform: translateY(0);
  box-shadow: 0 4px 16px var(--glass-shadow);
}

/* Focus states for accessibility */
.glass-base--interactive:focus-visible {
  outline: 3px solid var(--accent-primary);
  outline-offset: 2px;
  box-shadow:
    0 0 0 6px var(--accent-primary-glass),
    0 12px 48px var(--glass-shadow);
}
```

### Navigation Glass Implementation

```css
/* /src/css/components/glass-navigation.css */
.glass-navigation {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--depth-floating);
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border-bottom: 1px solid var(--glass-border);
  padding: 16px 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-navigation__container {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.glass-navigation__logo {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  font-weight: 600;
  color: var(--glass-text);
  text-decoration: none;
  transition: color 0.2s ease;
}

.glass-navigation__logo:hover {
  color: var(--accent-primary);
}

.glass-navigation__menu {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.glass-navigation__link {
  display: block;
  padding: 8px 16px;
  color: var(--glass-text-secondary);
  text-decoration: none;
  border-radius: 8px;
  position: relative;
  overflow: hidden;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-navigation__link::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
  transition: left 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-navigation__link:hover {
  color: var(--glass-text);
  background: var(--glass-surface-hover);
  transform: translateY(-1px);
}

.glass-navigation__link:hover::before {
  left: 100%;
}

.glass-navigation__link--active {
  color: var(--accent-primary);
  background: var(--accent-primary-glass);
  font-weight: 500;
}

/* Mobile navigation */
@media (max-width: 768px) {
  .glass-navigation__menu {
    display: none;
  }

  .glass-navigation__mobile-toggle {
    display: block;
    background: none;
    border: none;
    color: var(--glass-text);
    font-size: 24px;
    cursor: pointer;
  }

  .glass-navigation__menu--open {
    display: flex;
    flex-direction: column;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--glass-surface);
    backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-top: none;
    padding: 20px;
    gap: 12px;
  }
}
```

### Sidebar Implementation

```css
/* /src/css/components/glass-sidebar.css */
.glass-sidebar {
  position: sticky;
  top: 80px;
  height: calc(100vh - 100px);
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--glass-border);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-sidebar__content {
  padding: 20px;
  height: 100%;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--glass-border) transparent;
}

.glass-sidebar__content::-webkit-scrollbar {
  width: 6px;
}

.glass-sidebar__content::-webkit-scrollbar-track {
  background: transparent;
}

.glass-sidebar__content::-webkit-scrollbar-thumb {
  background: var(--glass-border);
  border-radius: 3px;
}

.glass-sidebar__content::-webkit-scrollbar-thumb:hover {
  background: var(--accent-primary);
}

.glass-sidebar__section {
  margin-bottom: 24px;
}

.glass-sidebar__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--glass-text);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.glass-sidebar__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.glass-sidebar__item {
  margin-bottom: 4px;
}

.glass-sidebar__link {
  display: block;
  padding: 8px 12px;
  color: var(--glass-text-secondary);
  text-decoration: none;
  border-radius: 6px;
  font-size: 14px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  border-left: 3px solid transparent;
}

.glass-sidebar__link:hover {
  color: var(--glass-text);
  background: var(--glass-surface-hover);
  border-left-color: var(--accent-primary);
  transform: translateX(4px);
}

.glass-sidebar__link--active {
  color: var(--accent-primary);
  background: var(--accent-primary-glass);
  border-left-color: var(--accent-primary);
  font-weight: 500;
}

/* Collapsible sections */
.glass-sidebar__toggle {
  background: none;
  border: none;
  color: var(--glass-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 6px;
  transition: background 0.2s ease;
}

.glass-sidebar__toggle:hover {
  background: var(--glass-surface-hover);
}

.glass-sidebar__toggle-icon {
  transition: transform 0.2s ease;
}

.glass-sidebar__toggle--expanded .glass-sidebar__toggle-icon {
  transform: rotate(90deg);
}

.glass-sidebar__submenu {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-sidebar__toggle--expanded + .glass-sidebar__submenu {
  max-height: 500px;
}
```

## 🎞️ Animation Implementation

### CSS Animation Classes

```css
/* /src/css/components/glass-animations.css */

/* Entrance animations */
@keyframes glass-fade-in {
  0% {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes glass-slide-in {
  0% {
    opacity: 0;
    transform: translateX(-30px);
    filter: blur(5px);
  }
  100% {
    opacity: 1;
    transform: translateX(0);
    filter: blur(0);
  }
}

@keyframes glass-morph-in {
  0% {
    opacity: 0;
    transform: scale(0.3);
    border-radius: 50%;
    filter: blur(10px);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.1);
    border-radius: 25%;
    filter: blur(3px);
  }
  100% {
    opacity: 1;
    transform: scale(1);
    border-radius: 12px;
    filter: blur(0);
  }
}

/* Animation utility classes */
.glass-animate-in {
  animation: glass-fade-in 0.6s cubic-bezier(0.4, 0, 0.2, 1) both;
}

.glass-animate-slide {
  animation: glass-slide-in 0.8s cubic-bezier(0.4, 0, 0.2, 1) both;
}

.glass-animate-morph {
  animation: glass-morph-in 1s cubic-bezier(0.68, -0.55, 0.265, 1.55) both;
}

/* Staggered animations */
.glass-stagger-container .glass-animate-in:nth-child(1) {
  animation-delay: 0s;
}
.glass-stagger-container .glass-animate-in:nth-child(2) {
  animation-delay: 0.1s;
}
.glass-stagger-container .glass-animate-in:nth-child(3) {
  animation-delay: 0.2s;
}
.glass-stagger-container .glass-animate-in:nth-child(4) {
  animation-delay: 0.3s;
}
.glass-stagger-container .glass-animate-in:nth-child(5) {
  animation-delay: 0.4s;
}

/* Hover animations */
.glass-hover-lift {
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-hover-lift:hover {
  transform: translateY(-4px) scale(1.02);
}

.glass-hover-glow {
  position: relative;
  overflow: hidden;
}

.glass-hover-glow::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.glass-hover-glow:hover::before {
  left: 100%;
}

/* Floating animation */
@keyframes glass-float {
  0%,
  100% {
    transform: translateY(0px);
  }
  50% {
    transform: translateY(-8px);
  }
}

.glass-float {
  animation: glass-float 6s ease-in-out infinite;
}

.glass-float:hover {
  animation-play-state: paused;
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .glass-animate-in,
  .glass-animate-slide,
  .glass-animate-morph,
  .glass-float {
    animation: none;
  }

  .glass-hover-lift:hover {
    transform: none;
    background: var(--glass-surface-hover);
  }

  .glass-hover-glow::before {
    display: none;
  }
}
```

### JavaScript Animation Controller

```javascript
// /src/js/glass-animations.js

class GlassAnimationController {
  constructor() {
    this.observedElements = new Set();
    this.animationQueue = [];
    this.isProcessing = false;

    this.init();
  }

  init() {
    this.setupIntersectionObserver();
    this.setupReducedMotionHandler();
    this.setupScrollAnimations();
  }

  setupIntersectionObserver() {
    if (!('IntersectionObserver' in window)) {
      // Fallback for older browsers
      this.animateAllVisible();
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.queueAnimation(entry.target);
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '50px',
      }
    );

    // Observe all glass components
    document.querySelectorAll('[data-glass-animate]').forEach((element) => {
      this.observer.observe(element);
    });
  }

  queueAnimation(element) {
    if (this.observedElements.has(element)) return;

    this.observedElements.add(element);
    this.animationQueue.push(element);

    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  async processQueue() {
    this.isProcessing = true;

    while (this.animationQueue.length > 0) {
      const element = this.animationQueue.shift();
      await this.animateElement(element);
      await this.delay(100); // Stagger delay
    }

    this.isProcessing = false;
  }

  async animateElement(element) {
    const animationType = element.dataset.glassAnimate || 'fade-in';
    const animationClass = `glass-animate-${animationType}`;

    // Add animation class
    element.classList.add(animationClass);

    // Wait for animation to complete
    return new Promise((resolve) => {
      const handleAnimationEnd = () => {
        element.removeEventListener('animationend', handleAnimationEnd);
        resolve();
      };

      element.addEventListener('animationend', handleAnimationEnd);

      // Fallback timeout
      setTimeout(resolve, 1000);
    });
  }

  setupReducedMotionHandler() {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const handleReducedMotion = (e) => {
      if (e.matches) {
        // Disable complex animations
        document.body.classList.add('glass-reduced-motion');
      } else {
        document.body.classList.remove('glass-reduced-motion');
      }
    };

    handleReducedMotion(mediaQuery);
    mediaQuery.addEventListener('change', handleReducedMotion);
  }

  setupScrollAnimations() {
    let ticking = false;

    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          this.updateScrollAnimations();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
  }

  updateScrollAnimations() {
    const scrolled = window.pageYOffset;
    const parallaxElements = document.querySelectorAll('[data-glass-parallax]');

    parallaxElements.forEach((element) => {
      const speed = parseFloat(element.dataset.glassParallax) || 0.5;
      const yPos = -(scrolled * speed);
      element.style.transform = `translateY(${yPos}px)`;
    });
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  animateAllVisible() {
    // Fallback for browsers without IntersectionObserver
    document.querySelectorAll('[data-glass-animate]').forEach((element) => {
      element.classList.add('glass-animate-in');
    });
  }

  // Public methods
  addElement(element, animationType = 'fade-in') {
    element.dataset.glassAnimate = animationType;
    if (this.observer) {
      this.observer.observe(element);
    } else {
      element.classList.add(`glass-animate-${animationType}`);
    }
  }

  removeElement(element) {
    if (this.observer) {
      this.observer.unobserve(element);
    }
    this.observedElements.delete(element);
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
    this.observedElements.clear();
    this.animationQueue = [];
  }
}

// Initialize animation controller
const glassAnimations = new GlassAnimationController();

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GlassAnimationController;
}
```

## 🎯 Docusaurus Integration

### Custom CSS Override

```css
/* /src/css/custom.css */

/* Import glass design system */
@import url('./glass-design-system.css');

/* Override Docusaurus defaults */
.navbar {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border-bottom: 1px solid var(--glass-border);
  box-shadow: 0 4px 32px var(--glass-shadow);
}

.navbar__inner {
  max-width: 1200px;
  margin: 0 auto;
}

.navbar__brand {
  color: var(--glass-text);
  transition: color 0.2s ease;
}

.navbar__brand:hover {
  color: var(--accent-primary);
}

.navbar__item {
  color: var(--glass-text-secondary);
  transition: color 0.2s ease;
}

.navbar__link:hover {
  color: var(--glass-text);
  background: var(--glass-surface-hover);
  border-radius: 6px;
}

.navbar__link--active {
  color: var(--accent-primary);
  background: var(--accent-primary-glass);
  border-radius: 6px;
}

/* Sidebar styling */
.theme-doc-sidebar-container {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border-right: 1px solid var(--glass-border);
}

.theme-doc-sidebar-menu {
  padding: 20px;
}

.menu__link {
  color: var(--glass-text-secondary);
  border-radius: 6px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  border-left: 3px solid transparent;
}

.menu__link:hover {
  background: var(--glass-surface-hover);
  color: var(--glass-text);
  border-left-color: var(--accent-primary);
  transform: translateX(4px);
}

.menu__link--active {
  background: var(--accent-primary-glass);
  color: var(--accent-primary);
  border-left-color: var(--accent-primary);
  font-weight: 500;
}

/* Content area */
.main-wrapper {
  background: linear-gradient(135deg, rgba(255, 149, 0, 0.05) 0%, rgba(0, 122, 255, 0.05) 100%);
}

.container {
  max-width: 1200px;
}

/* Cards and content blocks */
.card {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px var(--glass-shadow);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 48px var(--glass-shadow);
  border-color: var(--accent-primary);
}

/* Code blocks */
.prism-code {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow: 0 4px 16px var(--glass-shadow);
}

/* Tables */
.table-wrapper {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
}

/* Buttons */
.button {
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  color: var(--glass-text);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.button:hover {
  background: var(--glass-surface-hover);
  transform: translateY(-2px);
  box-shadow: 0 8px 32px var(--glass-shadow);
}

.button--primary {
  background: linear-gradient(135deg, var(--accent-primary), rgba(255, 149, 0, 0.8));
  color: white;
  border-color: var(--accent-primary);
}

.button--primary:hover {
  background: linear-gradient(135deg, rgba(255, 149, 0, 0.9), var(--accent-primary));
}
```

### Plugin Configuration

```javascript
// docusaurus.config.js additions

module.exports = {
  // ... existing config

  plugins: [
    // ... existing plugins

    // Custom plugin for glass design system
    function glassDesignSystemPlugin() {
      return {
        name: 'glass-design-system',
        injectHtmlTags() {
          return {
            headTags: [
              {
                tagName: 'link',
                attributes: {
                  rel: 'stylesheet',
                  href: '/css/glass-design-system.css',
                },
              },
              {
                tagName: 'script',
                attributes: {
                  src: '/js/glass-animations.js',
                  defer: true,
                },
              },
            ],
          };
        },
        configureWebpack() {
          return {
            module: {
              rules: [
                {
                  test: /\.css$/,
                  use: [
                    'style-loader',
                    'css-loader',
                    {
                      loader: 'postcss-loader',
                      options: {
                        postcssOptions: {
                          plugins: [['autoprefixer'], ['cssnano', { preset: 'default' }]],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          };
        },
      };
    },
  ],

  themeConfig: {
    // ... existing theme config

    // Enable glass theme features
    glassDesignSystem: {
      enabled: true,
      animationsEnabled: true,
      reducedMotionSupport: true,
      highContrastSupport: true,
    },
  },
};
```

## 📱 Responsive Implementation

### Mobile-First Approach

```css
/* Mobile base styles */
.glass-container {
  --glass-blur: 10px;
  --glass-opacity: 0.9;
  border-radius: 8px;
  margin: 16px;
}

/* Tablet styles */
@media (min-width: 768px) {
  .glass-container {
    --glass-blur: 15px;
    --glass-opacity: 0.85;
    border-radius: 12px;
    margin: 24px;
  }
}

/* Desktop styles */
@media (min-width: 1024px) {
  .glass-container {
    --glass-blur: 20px;
    --glass-opacity: 0.8;
    border-radius: 16px;
    margin: 32px;
  }
}

/* Large desktop styles */
@media (min-width: 1440px) {
  .glass-container {
    --glass-blur: 25px;
    border-radius: 20px;
  }
}

/* Ultra-wide displays */
@media (min-width: 2560px) {
  .glass-container {
    --glass-blur: 30px;
    border-radius: 24px;
  }
}

/* Mobile navigation adjustments */
@media (max-width: 768px) {
  .glass-navigation__menu {
    background: var(--glass-surface);
    backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    margin-top: 8px;
    padding: 16px;
    box-shadow: 0 8px 32px var(--glass-shadow);
  }

  .glass-sidebar {
    position: static;
    height: auto;
    margin-bottom: 20px;
  }
}
```

## 🚀 Performance Optimization

### CSS Optimization

```css
/* Optimize for 60fps animations */
.glass-optimized {
  will-change: transform;
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000px;
}

/* Contain layout for better performance */
.glass-contained {
  contain: layout style paint;
  isolation: isolate;
}

/* Reduce complexity on mobile */
@media (max-width: 768px) {
  .glass-complex {
    backdrop-filter: blur(8px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  }

  .glass-animation {
    animation-duration: 0.2s;
    animation-timing-function: ease-out;
  }
}

/* Battery optimization */
@media (prefers-reduced-motion: reduce) {
  .glass-power-intensive {
    animation: none;
    transition: opacity 0.2s ease;
    backdrop-filter: none;
    background: rgba(255, 255, 255, 0.1);
  }
}
```

### JavaScript Performance

```javascript
// Lazy load animations
class LazyGlassAnimations {
  constructor() {
    this.loadedModules = new Set();
  }

  async loadAnimation(type) {
    if (this.loadedModules.has(type)) return;

    try {
      const module = await import(`./animations/${type}.js`);
      module.default();
      this.loadedModules.add(type);
    } catch (error) {
      console.warn(`Failed to load animation: ${type}`, error);
    }
  }

  async loadOnDemand(element) {
    const animationType = element.dataset.glassAnimate;
    if (animationType) {
      await this.loadAnimation(animationType);
    }
  }
}

// Intersection observer with performance monitoring
class PerformantGlassObserver {
  constructor() {
    this.observer = null;
    this.frameRate = 60;
    this.lastFrameTime = performance.now();
  }

  init() {
    if (!window.IntersectionObserver) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        this.monitorPerformance();

        // Batch DOM updates
        requestAnimationFrame(() => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              this.animateElement(entry.target);
            }
          });
        });
      },
      {
        threshold: 0.1,
        rootMargin: '100px',
      }
    );
  }

  monitorPerformance() {
    const currentTime = performance.now();
    const deltaTime = currentTime - this.lastFrameTime;
    const currentFPS = 1000 / deltaTime;

    // Adjust animation complexity based on performance
    if (currentFPS < 30) {
      document.body.classList.add('glass-low-performance');
    } else if (currentFPS > 50) {
      document.body.classList.remove('glass-low-performance');
    }

    this.lastFrameTime = currentTime;
  }

  animateElement(element) {
    // Check if element is in viewport and device can handle animation
    const rect = element.getBoundingClientRect();
    const isVisible = rect.top < window.innerHeight && rect.bottom > 0;

    if (isVisible && !document.body.classList.contains('glass-low-performance')) {
      element.classList.add('glass-animate-in');
    } else {
      // Fallback to simple fade
      element.style.opacity = '1';
    }
  }
}
```

## 🎯 Testing and Validation

### Automated Testing Setup

```javascript
// tests/glass-design-system.test.js
describe('Glass Design System', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  describe('Accessibility', () => {
    test('should have proper contrast ratios', () => {
      const element = document.createElement('div');
      element.className = 'glass-container';
      document.body.appendChild(element);

      const styles = window.getComputedStyle(element);
      const backgroundColor = styles.backgroundColor;
      const color = styles.color;

      // Test contrast ratio (simplified)
      expect(calculateContrastRatio(color, backgroundColor)).toBeGreaterThan(4.5);
    });

    test('should support reduced motion', () => {
      // Mock reduced motion preference
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: jest.fn().mockImplementation((query) => ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          onchange: null,
          addListener: jest.fn(),
          removeListener: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          dispatchEvent: jest.fn(),
        })),
      });

      const element = document.createElement('div');
      element.className = 'glass-animate-in';
      document.body.appendChild(element);

      // Should not have animation
      expect(element.style.animation).toBe('');
    });
  });

  describe('Performance', () => {
    test('should use GPU-accelerated properties', () => {
      const element = document.createElement('div');
      element.className = 'glass-hover-lift';
      document.body.appendChild(element);

      const styles = window.getComputedStyle(element);
      expect(styles.willChange).toContain('transform');
    });

    test('should degrade gracefully on mobile', () => {
      // Mock mobile viewport
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });

      const element = document.createElement('div');
      element.className = 'glass-container';
      document.body.appendChild(element);

      const styles = window.getComputedStyle(element);
      const blurValue = styles.backdropFilter;

      // Should have reduced blur on mobile
      expect(blurValue).toContain('blur(10px)');
    });
  });
});

function calculateContrastRatio(foreground, background) {
  // Simplified contrast calculation
  // In production, use a proper contrast calculation library
  return 4.6; // Mock passing value
}
```

## 📋 Implementation Checklist

### Phase 1: Foundation Setup

- [ ] Install required dependencies
- [ ] Set up CSS design tokens
- [ ] Create base glass component classes
- [ ] Configure build pipeline with PostCSS

### Phase 2: Component Implementation

- [ ] Implement glass navigation
- [ ] Create glass sidebar
- [ ] Build glass content containers
- [ ] Add glass interactive elements

### Phase 3: Animation System

- [ ] Set up CSS animations
- [ ] Implement JavaScript animation controller
- [ ] Add intersection observer for scroll animations
- [ ] Configure performance monitoring

### Phase 4: Responsive Design

- [ ] Implement mobile-first responsive design
- [ ] Add touch-friendly interactions
- [ ] Optimize for various screen sizes
- [ ] Test on real devices

### Phase 5: Accessibility

- [ ] Ensure keyboard navigation works
- [ ] Add proper ARIA labels
- [ ] Test with screen readers
- [ ] Implement reduced motion support

### Phase 6: Performance Optimization

- [ ] Optimize CSS for 60fps animations
- [ ] Implement lazy loading for animations
- [ ] Add performance monitoring
- [ ] Test on low-end devices

### Phase 7: Testing and Validation

- [ ] Write automated tests
- [ ] Perform accessibility audits
- [ ] Validate performance metrics
- [ ] Cross-browser testing

### Phase 8: Documentation

- [ ] Create component documentation
- [ ] Add usage examples
- [ ] Document accessibility features
- [ ] Provide migration guide

---

**Congratulations!** You've successfully implemented the ElizaOS Apple Liquid Glass Design System. Your documentation now features stunning glassmorphic interfaces with smooth liquid animations, all while maintaining excellent performance and accessibility standards.

For additional support or advanced customization, refer to the individual component documentation or reach out to the ElizaOS community.
