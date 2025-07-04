# Performance Optimization Guide

Achieving smooth 60fps animations while maintaining the visual richness of the Apple Liquid Glass design system requires careful attention to performance optimization. This guide provides comprehensive strategies for maximizing performance across all devices and browsers.

## ⚡ Core Performance Principles

### GPU Acceleration Strategy

**Hardware Acceleration Triggers**

```css
/* Force GPU acceleration for smooth animations */
.gpu-accelerated {
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000px;
  will-change: transform;
}

/* Specific property optimization */
.transform-optimized {
  will-change: transform;
}

.opacity-optimized {
  will-change: opacity;
}

.filter-optimized {
  will-change: filter;
}

/* Clean up after animation */
.animation-complete {
  will-change: auto;
}
```

**Composite Layer Management**

```css
/* Create isolated layers for complex animations */
.composite-layer {
  contain: layout style paint;
  isolation: isolate;
  position: relative;
  z-index: 0;
}

/* Prevent layer thrashing */
.stable-layer {
  transform: translateZ(0);
  position: relative;
}
```

### Animation Property Hierarchy

**Optimal Properties (GPU Accelerated)**

1. `transform` - Translate, scale, rotate
2. `opacity` - Fade effects
3. `filter` - Blur, brightness (use sparingly)

**Avoid Animating (CPU Bound)**

- `width`, `height` - Use `transform: scale()` instead
- `top`, `left` - Use `transform: translate()` instead
- `margin`, `padding` - Use `transform` or `clip-path`
- `border-width` - Use `transform: scale()` or `box-shadow`

## 🎯 Optimization Strategies

### Efficient Transform Usage

```css
/* Optimized scaling */
.scale-animation {
  transform: scale(1);
  transition: transform 0.3s ease;
}

.scale-animation:hover {
  transform: scale(1.05);
}

/* Optimized movement */
.move-animation {
  transform: translate3d(0, 0, 0);
  transition: transform 0.3s ease;
}

.move-animation:hover {
  transform: translate3d(0, -8px, 0);
}

/* Combined transforms for efficiency */
.combined-transform {
  transform: translate3d(0, 0, 0) scale(1) rotate(0deg);
  transition: transform 0.3s ease;
}

.combined-transform:hover {
  transform: translate3d(0, -8px, 0) scale(1.05) rotate(2deg);
}
```

### Backdrop Filter Optimization

```css
/* Efficient backdrop filter implementation */
.glass-optimized {
  backdrop-filter: blur(20px);
  /* Fallback for better performance on older devices */
  background: rgba(255, 255, 255, 0.1);
}

/* Conditional backdrop filter */
@supports (backdrop-filter: blur(20px)) {
  .glass-optimized {
    backdrop-filter: blur(20px);
    background: rgba(255, 255, 255, 0.05);
  }
}

/* Reduce blur on mobile for better performance */
@media (max-width: 768px) {
  .glass-optimized {
    backdrop-filter: blur(10px);
  }
}

/* Disable on low-end devices */
@media (max-width: 480px) and (max-resolution: 1.5dppx) {
  .glass-optimized {
    backdrop-filter: none;
    background: rgba(255, 255, 255, 0.15);
  }
}
```

### Animation Containment

```css
/* Contain layout and paint for better performance */
.animation-container {
  contain: layout style paint;
  /* Isolate from parent stacking context */
  isolation: isolate;
  /* Create new layer */
  transform: translateZ(0);
}

/* Contain specific animation regions */
.contained-animation {
  contain: layout;
  overflow: hidden;
  position: relative;
}

/* Strict containment for complex animations */
.strict-containment {
  contain: strict;
  width: 100px;
  height: 100px;
}
```

## 📊 Performance Monitoring

### JavaScript Performance Monitor

```javascript
class LiquidPerformanceMonitor {
  constructor() {
    this.frameRate = {
      samples: [],
      average: 0,
      min: Infinity,
      max: 0,
    };

    this.memoryUsage = {
      initial: 0,
      current: 0,
      peak: 0,
    };

    this.animationCount = 0;
    this.isMonitoring = false;
    this.lastFrameTime = performance.now();
  }

  startMonitoring() {
    this.isMonitoring = true;
    this.recordInitialMemory();
    this.monitorFrame();
    this.setupPerformanceObserver();
  }

  monitorFrame() {
    if (!this.isMonitoring) return;

    const currentTime = performance.now();
    const deltaTime = currentTime - this.lastFrameTime;
    const fps = 1000 / deltaTime;

    this.updateFrameRate(fps);
    this.updateMemoryUsage();

    this.lastFrameTime = currentTime;
    requestAnimationFrame(() => this.monitorFrame());
  }

  updateFrameRate(fps) {
    this.frameRate.samples.push(fps);

    // Keep only last 60 samples (1 second at 60fps)
    if (this.frameRate.samples.length > 60) {
      this.frameRate.samples.shift();
    }

    this.frameRate.average =
      this.frameRate.samples.reduce((a, b) => a + b) / this.frameRate.samples.length;
    this.frameRate.min = Math.min(this.frameRate.min, fps);
    this.frameRate.max = Math.max(this.frameRate.max, fps);

    // Alert on performance issues
    if (this.frameRate.average < 30) {
      console.warn('Low FPS detected:', this.frameRate.average.toFixed(1));
      this.suggestOptimizations();
    }
  }

  updateMemoryUsage() {
    if ('memory' in performance) {
      this.memoryUsage.current = performance.memory.usedJSHeapSize / 1048576; // MB
      this.memoryUsage.peak = Math.max(this.memoryUsage.peak, this.memoryUsage.current);

      // Alert on memory leaks
      const memoryIncrease = this.memoryUsage.current - this.memoryUsage.initial;
      if (memoryIncrease > 50) {
        // 50MB increase
        console.warn('Potential memory leak detected:', memoryIncrease.toFixed(1), 'MB');
      }
    }
  }

  recordInitialMemory() {
    if ('memory' in performance) {
      this.memoryUsage.initial = performance.memory.usedJSHeapSize / 1048576;
    }
  }

  setupPerformanceObserver() {
    if ('PerformanceObserver' in window) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'measure' && entry.name.includes('animation')) {
            this.animationCount++;
          }
        }
      });

      observer.observe({ entryTypes: ['measure'] });
    }
  }

  suggestOptimizations() {
    const suggestions = [];

    if (this.frameRate.average < 30) {
      suggestions.push('Reduce animation complexity');
      suggestions.push('Decrease backdrop-filter blur radius');
      suggestions.push('Use transform instead of layout properties');
    }

    if (this.memoryUsage.current > this.memoryUsage.initial + 30) {
      suggestions.push('Check for animation cleanup');
      suggestions.push('Remove unused event listeners');
    }

    if (this.animationCount > 20) {
      suggestions.push('Limit concurrent animations');
      suggestions.push('Use animation pooling');
    }

    return suggestions;
  }

  getReport() {
    return {
      frameRate: {
        average: Math.round(this.frameRate.average * 10) / 10,
        min: Math.round(this.frameRate.min * 10) / 10,
        max: Math.round(this.frameRate.max * 10) / 10,
      },
      memory: {
        current: Math.round(this.memoryUsage.current * 10) / 10,
        peak: Math.round(this.memoryUsage.peak * 10) / 10,
        increase: Math.round((this.memoryUsage.current - this.memoryUsage.initial) * 10) / 10,
      },
      animations: this.animationCount,
      suggestions: this.suggestOptimizations(),
    };
  }

  stopMonitoring() {
    this.isMonitoring = false;
  }
}

// Usage
const performanceMonitor = new LiquidPerformanceMonitor();
performanceMonitor.startMonitoring();

// Check performance every 5 seconds
setInterval(() => {
  const report = performanceMonitor.getReport();
  console.log('Performance Report:', report);
}, 5000);
```

### Animation Pool Management

```javascript
class LiquidAnimationPool {
  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
    this.activeAnimations = new Set();
    this.queuedAnimations = [];
    this.completedAnimations = new WeakMap();
  }

  requestAnimation(element, keyframes, options) {
    return new Promise((resolve) => {
      const animationRequest = {
        element,
        keyframes,
        options,
        resolve,
      };

      if (this.activeAnimations.size < this.maxConcurrent) {
        this.executeAnimation(animationRequest);
      } else {
        this.queuedAnimations.push(animationRequest);
      }
    });
  }

  executeAnimation(request) {
    const { element, keyframes, options, resolve } = request;

    // Set will-change for performance
    element.style.willChange = this.getWillChangeValue(keyframes);

    const animation = element.animate(keyframes, {
      duration: 300,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'both',
      ...options,
    });

    this.activeAnimations.add(animation);

    animation.addEventListener('finish', () => {
      this.cleanupAnimation(animation, element);
      resolve(animation);
      this.processQueue();
    });

    animation.addEventListener('cancel', () => {
      this.cleanupAnimation(animation, element);
      this.processQueue();
    });
  }

  cleanupAnimation(animation, element) {
    this.activeAnimations.delete(animation);
    element.style.willChange = 'auto';

    // Store reference for potential reuse
    this.completedAnimations.set(element, animation);
  }

  processQueue() {
    if (this.queuedAnimations.length > 0 && this.activeAnimations.size < this.maxConcurrent) {
      const nextRequest = this.queuedAnimations.shift();
      this.executeAnimation(nextRequest);
    }
  }

  getWillChangeValue(keyframes) {
    const properties = new Set();

    keyframes.forEach((frame) => {
      Object.keys(frame).forEach((prop) => {
        if (prop === 'transform') properties.add('transform');
        if (prop === 'opacity') properties.add('opacity');
        if (prop === 'filter') properties.add('filter');
      });
    });

    return Array.from(properties).join(', ') || 'auto';
  }

  cancelAll() {
    this.activeAnimations.forEach((animation) => {
      animation.cancel();
    });
    this.queuedAnimations = [];
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
}

// Global animation pool
const liquidAnimationPool = new LiquidAnimationPool(8);

// Usage
liquidAnimationPool.requestAnimation(
  element,
  [
    { opacity: 0, transform: 'translateY(20px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ],
  { duration: 400 }
);
```

## 🎯 Device-Specific Optimizations

### Mobile Performance Optimization

```css
/* Reduce complexity on mobile devices */
@media (max-width: 768px) {
  .glass-container {
    backdrop-filter: blur(10px); /* Reduced from 20px */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1); /* Simplified shadow */
  }

  .liquid-animation {
    animation-duration: 0.2s; /* Faster animations */
    animation-timing-function: ease-out; /* Simpler easing */
  }

  /* Disable complex animations */
  .complex-animation {
    animation: none;
    transition: opacity 0.2s ease;
  }

  /* Reduce particle count */
  .particle-system {
    --particle-count: 5; /* Reduced from 20 */
  }
}

/* Ultra-low-end device detection */
@media (max-width: 480px) and (max-resolution: 1.5dppx) {
  .glass-effect {
    backdrop-filter: none;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(0, 0, 0, 0.1);
  }

  .animation-intensive {
    animation: none !important;
    transition: none !important;
  }
}

/* High-end mobile optimization */
@media (min-width: 768px) and (max-width: 1024px) and (min-resolution: 2dppx) {
  .glass-container {
    backdrop-filter: blur(15px);
  }

  .enhanced-animation {
    animation-duration: 0.4s;
  }
}
```

### Desktop Performance Scaling

```css
/* High-performance desktop */
@media (min-width: 1440px) and (min-resolution: 1.5dppx) {
  .glass-container {
    backdrop-filter: blur(25px);
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.15);
  }

  .enhanced-effects {
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.1));
  }
}

/* 4K and ultra-wide displays */
@media (min-width: 2560px) {
  .ultra-definition {
    backdrop-filter: blur(30px);
    box-shadow: 0 16px 64px rgba(0, 0, 0, 0.2);
  }
}
```

### GPU Memory Management

```javascript
class LiquidGPUMemoryManager {
  constructor() {
    this.textureCache = new Map();
    this.maxTextures = 50;
    this.memoryUsage = 0;
    this.memoryLimit = 100 * 1024 * 1024; // 100MB
  }

  estimateTextureMemory(width, height, hasAlpha = true) {
    const bytesPerPixel = hasAlpha ? 4 : 3;
    return width * height * bytesPerPixel;
  }

  cacheTexture(id, element) {
    if (this.textureCache.size >= this.maxTextures) {
      this.evictOldestTexture();
    }

    const rect = element.getBoundingClientRect();
    const estimatedMemory = this.estimateTextureMemory(rect.width, rect.height);

    if (this.memoryUsage + estimatedMemory > this.memoryLimit) {
      this.freeMemory(estimatedMemory);
    }

    this.textureCache.set(id, {
      element,
      timestamp: Date.now(),
      memory: estimatedMemory,
    });

    this.memoryUsage += estimatedMemory;
  }

  evictOldestTexture() {
    let oldestId = null;
    let oldestTime = Infinity;

    for (const [id, data] of this.textureCache) {
      if (data.timestamp < oldestTime) {
        oldestTime = data.timestamp;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.removeTexture(oldestId);
    }
  }

  freeMemory(needed) {
    const sorted = Array.from(this.textureCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    let freed = 0;
    for (const [id, data] of sorted) {
      this.removeTexture(id);
      freed += data.memory;

      if (freed >= needed) {
        break;
      }
    }
  }

  removeTexture(id) {
    const data = this.textureCache.get(id);
    if (data) {
      this.memoryUsage -= data.memory;
      this.textureCache.delete(id);

      // Clean up element styles
      data.element.style.willChange = 'auto';
    }
  }

  cleanup() {
    this.textureCache.clear();
    this.memoryUsage = 0;
  }

  getMemoryReport() {
    return {
      textureCount: this.textureCache.size,
      memoryUsage: Math.round((this.memoryUsage / 1024 / 1024) * 10) / 10, // MB
      memoryLimit: Math.round(this.memoryLimit / 1024 / 1024), // MB
      utilizationPercent: Math.round((this.memoryUsage / this.memoryLimit) * 100),
    };
  }
}

const gpuMemoryManager = new LiquidGPUMemoryManager();
```

## 🔧 Browser-Specific Optimizations

### Safari Optimizations

```css
/* Safari backdrop-filter optimization */
@supports (-webkit-backdrop-filter: blur(20px)) {
  .glass-safari {
    -webkit-backdrop-filter: blur(20px);
    backdrop-filter: blur(20px);
  }
}

/* Safari transform3d optimization */
.safari-optimized {
  -webkit-transform: translate3d(0, 0, 0);
  transform: translate3d(0, 0, 0);
  -webkit-backface-visibility: hidden;
  backface-visibility: hidden;
}

/* Safari animation smoothing */
.safari-smooth {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

### Chrome/Edge Optimizations

```css
/* Chrome containment optimization */
.chrome-optimized {
  contain: layout style paint;
  content-visibility: auto;
  contain-intrinsic-size: 0 200px;
}

/* Chrome layer promotion */
.chrome-layer {
  will-change: transform;
  isolation: isolate;
}
```

### Firefox Optimizations

```css
/* Firefox layer optimization */
.firefox-optimized {
  transform: translateZ(0);
  -moz-transform: translateZ(0);
}

/* Firefox backdrop-filter fallback */
@supports not (backdrop-filter: blur(20px)) {
  .firefox-glass {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
}
```

## 📊 Performance Testing Framework

```javascript
class LiquidPerformanceTester {
  constructor() {
    this.tests = new Map();
    this.results = new Map();
  }

  addTest(name, testFunction, options = {}) {
    this.tests.set(name, {
      fn: testFunction,
      iterations: options.iterations || 100,
      warmup: options.warmup || 10,
    });
  }

  async runTest(name) {
    const test = this.tests.get(name);
    if (!test) {
      throw new Error(`Test '${name}' not found`);
    }

    // Warmup
    for (let i = 0; i < test.warmup; i++) {
      await test.fn();
    }

    // Actual test
    const times = [];
    for (let i = 0; i < test.iterations; i++) {
      const start = performance.now();
      await test.fn();
      const end = performance.now();
      times.push(end - start);
    }

    const result = this.analyzeResults(times);
    this.results.set(name, result);
    return result;
  }

  analyzeResults(times) {
    const sorted = times.slice().sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b) / times.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return {
      average: Math.round(avg * 100) / 100,
      median: Math.round(median * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      p99: Math.round(p99 * 100) / 100,
      min: Math.round(sorted[0] * 100) / 100,
      max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
  }

  async runAllTests() {
    const results = new Map();

    for (const [name] of this.tests) {
      console.log(`Running test: ${name}`);
      const result = await this.runTest(name);
      results.set(name, result);
    }

    return results;
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      tests: {},
    };

    for (const [name, result] of this.results) {
      report.tests[name] = result;
    }

    return report;
  }
}

// Usage example
const tester = new LiquidPerformanceTester();

// Add animation performance test
tester.addTest('glass-button-hover', async () => {
  const button = document.querySelector('.glass-button');
  button.dispatchEvent(new Event('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  button.dispatchEvent(new Event('mouseleave'));
});

// Add backdrop filter test
tester.addTest('backdrop-filter-blur', async () => {
  const element = document.createElement('div');
  element.style.backdropFilter = 'blur(20px)';
  document.body.appendChild(element);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  document.body.removeChild(element);
});

// Run tests
tester.runAllTests().then((results) => {
  console.log('Performance test results:', results);
});
```

## 🎯 Optimization Checklist

### Pre-Launch Performance Audit

```markdown
## Animation Performance Checklist

### CSS Optimizations

- [ ] All animations use transform/opacity only
- [ ] will-change property is properly managed
- [ ] contain property is used for complex animations
- [ ] Backdrop-filter usage is minimized
- [ ] Box-shadow complexity is reduced

### JavaScript Optimizations

- [ ] Animation pooling is implemented
- [ ] Intersection Observer is used for scroll animations
- [ ] Event listeners are properly cleaned up
- [ ] Memory leaks are prevented
- [ ] Performance monitoring is in place

### Device Optimizations

- [ ] Mobile-specific performance tweaks
- [ ] Reduced motion preferences are respected
- [ ] Low-end device fallbacks are provided
- [ ] High-DPI display optimizations
- [ ] Touch vs hover detection

### Browser Compatibility

- [ ] Safari backdrop-filter support
- [ ] Chrome containment features
- [ ] Firefox layer optimization
- [ ] Edge performance features
- [ ] Fallbacks for unsupported features

### Testing

- [ ] Performance tests on various devices
- [ ] Animation smoothness validation
- [ ] Memory usage monitoring
- [ ] Battery impact assessment
- [ ] Accessibility compliance check
```

---

**Next Steps**: Continue to [Accessibility Guidelines](/docs/design-system/accessibility) for ensuring the glass design system is inclusive and accessible to all users.
