# Liquid Animation System

The ElizaOS Liquid Animation System provides smooth, organic animations that embody the fluidity of water and the elegance of glass. Every animation is designed to feel natural, purposeful, and performant at 60fps.

## 🌊 Animation Philosophy

### Liquid Motion Principles

**Organic Flow**

- Animations follow natural physics curves
- Elastic easing for playful interactions
- Fluid transitions between states

**Contextual Response**

- Animations scale with user intent
- Micro-interactions provide immediate feedback
- Macro-animations guide user attention

**Performance Excellence**

- GPU-accelerated transforms
- Optimized for 60fps on all devices
- Graceful degradation for older hardware

## ⚡ Core Animation Framework

### Timing Functions

```css
/* Core Easing Curves */
:root {
  /* Liquid easing - primary animation curve */
  --liquid-ease: cubic-bezier(0.4, 0, 0.2, 1);

  /* Bounce - for playful interactions */
  --liquid-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);

  /* Gentle - for subtle state changes */
  --liquid-gentle: cubic-bezier(0.25, 0.46, 0.45, 0.94);

  /* Sharp - for quick interactions */
  --liquid-sharp: cubic-bezier(0.25, 0.46, 0.45, 0.94);

  /* Elastic - for emphasis */
  --liquid-elastic: cubic-bezier(0.68, -0.6, 0.32, 1.6);
}
```

### Duration Scale

```css
/* Animation Durations */
:root {
  /* Micro interactions */
  --liquid-duration-instant: 0.1s;
  --liquid-duration-fast: 0.2s;

  /* Standard interactions */
  --liquid-duration-medium: 0.4s;
  --liquid-duration-slow: 0.6s;

  /* Macro animations */
  --liquid-duration-slower: 0.8s;
  --liquid-duration-crawl: 1.2s;
}
```

### Performance Utilities

```css
/* Hardware Acceleration */
.liquid-accelerated {
  transform: translateZ(0);
  will-change: transform;
  backface-visibility: hidden;
  perspective: 1000px;
}

/* Animation Optimization */
.liquid-optimized {
  contain: layout style paint;
  isolation: isolate;
}

/* Reduced Motion Support */
@media (prefers-reduced-motion: reduce) {
  .liquid-animated {
    animation: none !important;
    transition: none !important;
  }

  .liquid-animated--essential {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 🎭 Animation Patterns

### Entrance Animations

**Fade Scale In**

```css
@keyframes liquid-fade-scale-in {
  0% {
    opacity: 0;
    transform: scale(0.8) translateY(20px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.liquid-entrance--fade-scale {
  animation: liquid-fade-scale-in var(--liquid-duration-medium) var(--liquid-ease) both;
}
```

**Slide Blur In**

```css
@keyframes liquid-slide-blur-in {
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

.liquid-entrance--slide-blur {
  animation: liquid-slide-blur-in var(--liquid-duration-slow) var(--liquid-gentle) both;
}
```

**Liquid Morph In**

```css
@keyframes liquid-morph-in {
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

.liquid-entrance--morph {
  animation: liquid-morph-in var(--liquid-duration-slower) var(--liquid-bounce) both;
}
```

### Exit Animations

**Fade Scale Out**

```css
@keyframes liquid-fade-scale-out {
  0% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  100% {
    opacity: 0;
    transform: scale(0.9) translateY(-10px);
  }
}

.liquid-exit--fade-scale {
  animation: liquid-fade-scale-out var(--liquid-duration-fast) var(--liquid-ease) both;
}
```

**Dissolve Out**

```css
@keyframes liquid-dissolve-out {
  0% {
    opacity: 1;
    transform: scale(1);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: scale(1.05);
    filter: blur(8px);
  }
}

.liquid-exit--dissolve {
  animation: liquid-dissolve-out var(--liquid-duration-medium) var(--liquid-gentle) both;
}
```

### Hover Interactions

**Gentle Lift**

```css
.liquid-hover--lift {
  transition: transform var(--liquid-duration-fast) var(--liquid-ease);
}

.liquid-hover--lift:hover {
  transform: translateY(-4px) scale(1.02);
}
```

**Glass Shimmer**

```css
.liquid-hover--shimmer {
  position: relative;
  overflow: hidden;
}

.liquid-hover--shimmer::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left var(--liquid-duration-slow) var(--liquid-ease);
}

.liquid-hover--shimmer:hover::before {
  left: 100%;
}
```

**Magnetic Pull**

```css
.liquid-hover--magnetic {
  transition: all var(--liquid-duration-fast) var(--liquid-ease);
  cursor: pointer;
}

.liquid-hover--magnetic:hover {
  transform: translateY(-2px) scale(1.05);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.15);
}

.liquid-hover--magnetic:active {
  transform: translateY(0) scale(1.02);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}
```

### Loading Animations

**Liquid Spinner**

```css
@keyframes liquid-spinner {
  0% {
    transform: rotate(0deg) scale(1);
    border-radius: 50%;
  }
  50% {
    transform: rotate(180deg) scale(1.1);
    border-radius: 30%;
  }
  100% {
    transform: rotate(360deg) scale(1);
    border-radius: 50%;
  }
}

.liquid-loading--spinner {
  width: 24px;
  height: 24px;
  border: 2px solid transparent;
  border-top: 2px solid var(--accent-primary);
  animation: liquid-spinner var(--liquid-duration-crawl) var(--liquid-ease) infinite;
}
```

**Pulse Wave**

```css
@keyframes liquid-pulse-wave {
  0% {
    transform: scale(0.8);
    opacity: 1;
  }
  100% {
    transform: scale(1.4);
    opacity: 0;
  }
}

.liquid-loading--pulse {
  position: relative;
}

.liquid-loading--pulse::before,
.liquid-loading--pulse::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border: 2px solid var(--accent-primary);
  border-radius: inherit;
  animation: liquid-pulse-wave 2s var(--liquid-ease) infinite;
}

.liquid-loading--pulse::after {
  animation-delay: 0.5s;
}
```

**Breathing Dots**

```css
@keyframes liquid-breathing-dots {
  0%,
  80%,
  100% {
    transform: scale(0.8);
    opacity: 0.5;
  }
  40% {
    transform: scale(1.2);
    opacity: 1;
  }
}

.liquid-loading--dots {
  display: flex;
  gap: 4px;
}

.liquid-loading--dots .dot {
  width: 8px;
  height: 8px;
  background: var(--accent-primary);
  border-radius: 50%;
  animation: liquid-breathing-dots 1.4s var(--liquid-ease) infinite;
}

.liquid-loading--dots .dot:nth-child(1) {
  animation-delay: 0s;
}
.liquid-loading--dots .dot:nth-child(2) {
  animation-delay: 0.2s;
}
.liquid-loading--dots .dot:nth-child(3) {
  animation-delay: 0.4s;
}
```

### State Transitions

**Content Morph**

```css
.liquid-transition--morph {
  position: relative;
  overflow: hidden;
}

.liquid-transition--morph .content {
  transition: all var(--liquid-duration-medium) var(--liquid-ease);
}

.liquid-transition--morph .content--entering {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

.liquid-transition--morph .content--entered {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.liquid-transition--morph .content--exiting {
  opacity: 0;
  transform: translateY(-20px) scale(1.05);
}
```

**Accordion Expand**

```css
.liquid-accordion {
  overflow: hidden;
  transition: height var(--liquid-duration-medium) var(--liquid-ease);
}

.liquid-accordion--collapsed {
  height: 0;
}

.liquid-accordion--expanded {
  height: auto;
}

.liquid-accordion__content {
  transform: translateY(-10px);
  opacity: 0;
  transition: all var(--liquid-duration-medium) var(--liquid-ease) 0.1s;
}

.liquid-accordion--expanded .liquid-accordion__content {
  transform: translateY(0);
  opacity: 1;
}
```

## 🎯 Interactive Microanimations

### Button Interactions

```css
.liquid-button {
  position: relative;
  overflow: hidden;
  transition: all var(--liquid-duration-fast) var(--liquid-ease);
}

/* Ripple Effect */
.liquid-button::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  transform: translate(-50%, -50%);
  transition:
    width var(--liquid-duration-medium) var(--liquid-ease),
    height var(--liquid-duration-medium) var(--liquid-ease);
}

.liquid-button:active::after {
  width: 300px;
  height: 300px;
}

/* Magnetic hover */
.liquid-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}

.liquid-button:active {
  transform: translateY(0);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}
```

### Card Interactions

```css
.liquid-card {
  transition: all var(--liquid-duration-medium) var(--liquid-ease);
  cursor: pointer;
}

.liquid-card:hover {
  transform: translateY(-8px) rotateX(5deg);
  box-shadow: 0 20px 80px rgba(0, 0, 0, 0.2);
}

.liquid-card:hover .liquid-card__image {
  transform: scale(1.05);
  filter: brightness(1.1);
}

.liquid-card:active {
  transform: translateY(-4px) rotateX(2deg) scale(0.98);
}
```

### Input Interactions

```css
.liquid-input {
  transition: all var(--liquid-duration-fast) var(--liquid-ease);
  position: relative;
}

.liquid-input__field {
  border: 1px solid var(--glass-border);
  background: var(--glass-surface);
  backdrop-filter: blur(var(--glass-blur));
  transition: all var(--liquid-duration-fast) var(--liquid-ease);
}

.liquid-input__field:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-primary-glass);
  transform: scale(1.02);
}

/* Floating label */
.liquid-input__label {
  position: absolute;
  top: 50%;
  left: 12px;
  transform: translateY(-50%);
  color: var(--glass-text-secondary);
  pointer-events: none;
  transition: all var(--liquid-duration-fast) var(--liquid-ease);
}

.liquid-input__field:focus + .liquid-input__label,
.liquid-input__field:not(:placeholder-shown) + .liquid-input__label {
  top: 0;
  left: 8px;
  transform: translateY(-50%) scale(0.85);
  color: var(--accent-primary);
  background: var(--glass-surface);
  padding: 0 4px;
}
```

## 🎪 Complex Animation Sequences

### Page Transition

```css
.liquid-page-transition {
  position: relative;
}

/* Exit animation */
.liquid-page-transition--exiting .liquid-page-content {
  animation: liquid-page-exit var(--liquid-duration-slow) var(--liquid-ease) forwards;
}

@keyframes liquid-page-exit {
  0% {
    opacity: 1;
    transform: scale(1) translateY(0);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: scale(0.95) translateY(-20px);
    filter: blur(5px);
  }
}

/* Enter animation */
.liquid-page-transition--entering .liquid-page-content {
  animation: liquid-page-enter var(--liquid-duration-slow) var(--liquid-ease) forwards;
}

@keyframes liquid-page-enter {
  0% {
    opacity: 0;
    transform: scale(1.05) translateY(20px);
    filter: blur(5px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
    filter: blur(0);
  }
}
```

### Staggered List Animation

```css
.liquid-stagger-list {
  --stagger-delay: 0.1s;
}

.liquid-stagger-list .liquid-stagger-item {
  opacity: 0;
  transform: translateY(20px);
  animation: liquid-stagger-in var(--liquid-duration-medium) var(--liquid-ease) both;
}

.liquid-stagger-list .liquid-stagger-item:nth-child(1) {
  animation-delay: calc(1 * var(--stagger-delay));
}
.liquid-stagger-list .liquid-stagger-item:nth-child(2) {
  animation-delay: calc(2 * var(--stagger-delay));
}
.liquid-stagger-list .liquid-stagger-item:nth-child(3) {
  animation-delay: calc(3 * var(--stagger-delay));
}
.liquid-stagger-list .liquid-stagger-item:nth-child(4) {
  animation-delay: calc(4 * var(--stagger-delay));
}
.liquid-stagger-list .liquid-stagger-item:nth-child(5) {
  animation-delay: calc(5 * var(--stagger-delay));
}

@keyframes liquid-stagger-in {
  0% {
    opacity: 0;
    transform: translateY(20px) scale(0.9);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
```

### Modal Sequence

```css
/* Backdrop animation */
.liquid-modal-backdrop {
  opacity: 0;
  backdrop-filter: blur(0);
  transition: all var(--liquid-duration-medium) var(--liquid-ease);
}

.liquid-modal--open .liquid-modal-backdrop {
  opacity: 1;
  backdrop-filter: blur(8px);
}

/* Content animation */
.liquid-modal-content {
  opacity: 0;
  transform: scale(0.8) translateY(40px);
  transition: all var(--liquid-duration-medium) var(--liquid-bounce) 0.1s;
}

.liquid-modal--open .liquid-modal-content {
  opacity: 1;
  transform: scale(1) translateY(0);
}

/* Header animation */
.liquid-modal-header {
  opacity: 0;
  transform: translateY(-10px);
  transition: all var(--liquid-duration-fast) var(--liquid-ease) 0.2s;
}

.liquid-modal--open .liquid-modal-header {
  opacity: 1;
  transform: translateY(0);
}

/* Body animation */
.liquid-modal-body {
  opacity: 0;
  transform: translateY(10px);
  transition: all var(--liquid-duration-fast) var(--liquid-ease) 0.3s;
}

.liquid-modal--open .liquid-modal-body {
  opacity: 1;
  transform: translateY(0);
}
```

## ⚡ Performance Optimization

### GPU Acceleration Strategies

```css
/* Force GPU acceleration */
.liquid-gpu-accelerated {
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000px;
  will-change: transform;
}

/* Optimize for specific properties */
.liquid-optimized-transform {
  will-change: transform;
}

.liquid-optimized-opacity {
  will-change: opacity;
}

.liquid-optimized-filter {
  will-change: filter;
}

/* Remove will-change after animation */
.liquid-animation-complete {
  will-change: auto;
}
```

### Animation Performance Monitoring

```javascript
class LiquidAnimationMonitor {
  constructor() {
    this.frameCount = 0;
    this.startTime = performance.now();
    this.isMonitoring = false;
  }

  startMonitoring() {
    this.isMonitoring = true;
    this.frameCount = 0;
    this.startTime = performance.now();
    this.monitorFrame();
  }

  monitorFrame() {
    if (!this.isMonitoring) return;

    this.frameCount++;
    const currentTime = performance.now();
    const elapsed = currentTime - this.startTime;

    if (elapsed >= 1000) {
      const fps = Math.round(this.frameCount / (elapsed / 1000));
      console.log(`Animation FPS: ${fps}`);

      if (fps < 30) {
        console.warn('Low FPS detected, consider reducing animation complexity');
      }

      this.frameCount = 0;
      this.startTime = currentTime;
    }

    requestAnimationFrame(() => this.monitorFrame());
  }

  stopMonitoring() {
    this.isMonitoring = false;
  }
}

// Usage
const monitor = new LiquidAnimationMonitor();
monitor.startMonitoring();
```

### Intersection Observer for Performance

```javascript
class LiquidIntersectionAnimator {
  constructor(elements, options = {}) {
    this.elements = elements;
    this.options = {
      threshold: 0.1,
      rootMargin: '50px',
      ...options,
    };

    this.observer = new IntersectionObserver(this.handleIntersection.bind(this), this.options);

    this.init();
  }

  init() {
    this.elements.forEach((element) => {
      this.observer.observe(element);
    });
  }

  handleIntersection(entries) {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        this.animateIn(entry.target);
      } else {
        this.animateOut(entry.target);
      }
    });
  }

  animateIn(element) {
    element.style.animation = 'liquid-fade-scale-in 0.6s ease-out both';
  }

  animateOut(element) {
    element.style.animation = 'none';
  }

  destroy() {
    this.observer.disconnect();
  }
}

// Usage
const animatedElements = document.querySelectorAll('.liquid-animate-on-scroll');
const animator = new LiquidIntersectionAnimator(animatedElements);
```

## 🎨 Advanced Animation Techniques

### Morphing Shapes

```css
.liquid-morph {
  transition: all var(--liquid-duration-slow) var(--liquid-ease);
}

.liquid-morph--circle {
  border-radius: 50%;
  width: 60px;
  height: 60px;
}

.liquid-morph--square {
  border-radius: 8px;
  width: 60px;
  height: 60px;
}

.liquid-morph--rectangle {
  border-radius: 12px;
  width: 120px;
  height: 40px;
}

/* Smooth path morphing with clip-path */
.liquid-path-morph {
  transition: clip-path var(--liquid-duration-slow) var(--liquid-ease);
}

.liquid-path-morph--state-1 {
  clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
}

.liquid-path-morph--state-2 {
  clip-path: polygon(0% 0%, 0% 100%, 100% 100%, 100% 0%);
}
```

### Liquid Flow Effects

```css
@keyframes liquid-flow {
  0% {
    transform: translateX(-100%) skewX(-15deg);
  }
  100% {
    transform: translateX(100%) skewX(-15deg);
  }
}

.liquid-flow-container {
  position: relative;
  overflow: hidden;
}

.liquid-flow-container::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  animation: liquid-flow 2s ease-in-out infinite;
}
```

### Particle System

```javascript
class LiquidParticleSystem {
  constructor(container, options = {}) {
    this.container = container;
    this.particles = [];
    this.options = {
      count: 20,
      speed: 1,
      size: 2,
      color: 'rgba(255, 149, 0, 0.6)',
      ...options,
    };

    this.init();
  }

  init() {
    this.createParticles();
    this.animate();
  }

  createParticles() {
    for (let i = 0; i < this.options.count; i++) {
      const particle = document.createElement('div');
      particle.className = 'liquid-particle';
      particle.style.cssText = `
        position: absolute;
        width: ${this.options.size}px;
        height: ${this.options.size}px;
        background: ${this.options.color};
        border-radius: 50%;
        pointer-events: none;
      `;

      this.container.appendChild(particle);
      this.particles.push({
        element: particle,
        x: Math.random() * this.container.offsetWidth,
        y: Math.random() * this.container.offsetHeight,
        vx: (Math.random() - 0.5) * this.options.speed,
        vy: (Math.random() - 0.5) * this.options.speed,
      });
    }
  }

  animate() {
    this.particles.forEach((particle) => {
      particle.x += particle.vx;
      particle.y += particle.vy;

      // Boundary collision
      if (particle.x <= 0 || particle.x >= this.container.offsetWidth) {
        particle.vx *= -1;
      }
      if (particle.y <= 0 || particle.y >= this.container.offsetHeight) {
        particle.vy *= -1;
      }

      particle.element.style.transform = `translate(${particle.x}px, ${particle.y}px)`;
    });

    requestAnimationFrame(() => this.animate());
  }
}
```

## 📱 Responsive Animation Considerations

### Device-Specific Optimizations

```css
/* Reduce complexity on mobile */
@media (max-width: 768px) {
  .liquid-complex-animation {
    animation: liquid-simple-fade var(--liquid-duration-fast) ease-out;
  }

  .liquid-particle-system {
    display: none;
  }

  .liquid-3d-transform {
    transform: none;
  }
}

/* Enhanced animations for high-end devices */
@media (min-width: 1024px) and (prefers-reduced-motion: no-preference) {
  .liquid-enhanced {
    animation: liquid-complex-sequence var(--liquid-duration-slower) var(--liquid-ease);
  }
}

/* Battery considerations */
@media (prefers-reduced-motion: reduce) {
  .liquid-power-intensive {
    animation: none;
    transition: opacity var(--liquid-duration-fast) ease;
  }
}
```

### Touch vs Hover Interactions

```css
/* Hover-enabled devices */
@media (hover: hover) and (pointer: fine) {
  .liquid-hover-animation:hover {
    animation: liquid-hover-sequence var(--liquid-duration-medium) var(--liquid-ease);
  }
}

/* Touch devices */
@media (hover: none) and (pointer: coarse) {
  .liquid-touch-animation:active {
    animation: liquid-touch-feedback var(--liquid-duration-fast) var(--liquid-ease);
  }

  .liquid-touch-animation {
    -webkit-tap-highlight-color: transparent;
  }
}
```

## 🎯 Implementation Best Practices

### Animation Lifecycle Management

```javascript
class LiquidAnimationController {
  constructor() {
    this.activeAnimations = new Map();
    this.observers = new Map();
  }

  registerAnimation(element, animationName, options = {}) {
    const animation = element.animate(this.getKeyframes(animationName), {
      duration: options.duration || 400,
      easing: options.easing || 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'both',
      ...options,
    });

    this.activeAnimations.set(element, animation);

    animation.addEventListener('finish', () => {
      this.cleanupAnimation(element);
    });

    return animation;
  }

  cleanupAnimation(element) {
    if (this.activeAnimations.has(element)) {
      this.activeAnimations.delete(element);
      element.style.willChange = 'auto';
    }
  }

  pauseAll() {
    this.activeAnimations.forEach((animation) => {
      animation.pause();
    });
  }

  resumeAll() {
    this.activeAnimations.forEach((animation) => {
      animation.play();
    });
  }

  getKeyframes(animationName) {
    const keyframes = {
      fadeIn: [
        { opacity: 0, transform: 'translateY(20px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      scaleIn: [
        { opacity: 0, transform: 'scale(0.8)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      slideIn: [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }],
    };

    return keyframes[animationName] || keyframes.fadeIn;
  }
}

// Global instance
const liquidAnimations = new LiquidAnimationController();
```

### Performance Monitoring and Debugging

```javascript
class LiquidPerformanceMonitor {
  constructor() {
    this.metrics = {
      frameDrops: 0,
      avgFrameTime: 0,
      totalFrames: 0,
    };

    this.isMonitoring = false;
    this.lastFrameTime = performance.now();
  }

  startMonitoring() {
    this.isMonitoring = true;
    this.monitorFrame();
  }

  monitorFrame() {
    if (!this.isMonitoring) return;

    const currentTime = performance.now();
    const frameTime = currentTime - this.lastFrameTime;

    this.metrics.totalFrames++;
    this.metrics.avgFrameTime =
      (this.metrics.avgFrameTime * (this.metrics.totalFrames - 1) + frameTime) /
      this.metrics.totalFrames;

    // Detect frame drops (> 16.67ms for 60fps)
    if (frameTime > 16.67) {
      this.metrics.frameDrops++;
    }

    this.lastFrameTime = currentTime;
    requestAnimationFrame(() => this.monitorFrame());
  }

  getReport() {
    const fps = 1000 / this.metrics.avgFrameTime;
    const dropRate = (this.metrics.frameDrops / this.metrics.totalFrames) * 100;

    return {
      averageFPS: Math.round(fps),
      frameDropRate: Math.round(dropRate * 100) / 100,
      totalFrames: this.metrics.totalFrames,
      frameDrops: this.metrics.frameDrops,
    };
  }
}
```

---

**Next Steps**: Continue to [Performance Guidelines](/docs/design-system/performance) for detailed optimization strategies and implementation techniques.
