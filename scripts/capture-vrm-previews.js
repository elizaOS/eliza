/**
 * VRM Preview Capture Script
 *
 * Paste this entire script into the browser console while the app is running
 * with the character/companion view visible (VRM avatar must be loaded).
 *
 * It captures all bundled VRM avatars with spring bone physics DISABLED
 * so hair and cloth render in their rest pose.
 *
 * Usage:
 *   // Paste script, then run:
 *   await captureAllPreviews()
 *
 *   // Custom resolution:
 *   await captureAllPreviews({ width: 1024, height: 1536 })
 */

async function captureAllPreviews(options = {}) {
  const WIDTH = options.width || 512;
  const HEIGHT = options.height || 768;

  // Find the active engine
  const registry = window.__ELIZA_VRM_ENGINES__ || [];
  const entry = registry.find(e => e.role === 'world-stage') || registry[0];
  if (!entry) {
    console.error('No VRM engine found. Make sure the companion/character view is active.');
    return;
  }
  const engine = entry.engine;

  // Determine VRM assets
  const assets = window.__APP_VRM_ASSETS__ || [
    { slug: 'eliza-1' }, { slug: 'eliza-4' },
    { slug: 'eliza-5' }, { slug: 'eliza-9' },
  ];
  const count = assets.length;
  console.log(`%cCapturing ${count} VRM previews at ${WIDTH}x${HEIGHT} (physics OFF)`, 'font-weight:bold;color:#4fc3f7');

  for (let i = 0; i < count; i++) {
    const slug = assets[i].slug;
    const vrmUrl = `/vrms/${slug}.vrm.gz`;
    console.log(`[${i + 1}/${count}] ${slug}...`);

    try {
      // Load the VRM and wait for idle
      await engine.loadVrmFromUrl(vrmUrl, slug);
      await new Promise(r => setTimeout(r, 1000));

      // --- PAUSE the render loop ---
      if (typeof engine.setPaused === 'function') {
        engine.setPaused(true);
      } else {
        engine.paused = true;
        if (engine.animationFrameId != null) {
          cancelAnimationFrame(engine.animationFrameId);
          engine.animationFrameId = null;
        }
      }

      // --- RESET spring bones to rest pose ---
      const vrm = engine.vrm;
      if (vrm?.springBoneManager) {
        vrm.springBoneManager.reset();
        // Also reset prevTail to match currentTail so there's no velocity
        if (vrm.springBoneManager.joints) {
          for (const joint of vrm.springBoneManager.joints) {
            if (joint._prevTail && joint._currentTail) {
              joint._prevTail.copy(joint._currentTail);
            }
          }
        }
      }

      // Update humanoid only (no physics)
      if (vrm?.humanoid?.update) vrm.humanoid.update();
      if (vrm?.expressionManager?.update) vrm.expressionManager.update();

      // --- RENDER at capture resolution ---
      const renderer = engine.renderer;
      const scene = engine.scene;
      const camera = engine.camera;
      const canvas = renderer.domElement;

      const prevW = canvas.width;
      const prevH = canvas.height;

      renderer.setPixelRatio(1);
      renderer.setSize(WIDTH, HEIGHT);
      camera.aspect = WIDTH / HEIGHT;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);

      // --- CAPTURE ---
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${slug}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`  %c✓ ${slug}.png (${(blob.size / 1024).toFixed(1)}KB)`, 'color:#66bb6a');
      } else {
        console.warn(`  ✗ Failed to capture ${slug}`);
      }

      // --- RESTORE ---
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(prevW, prevH);
      camera.aspect = prevW / prevH;
      camera.updateProjectionMatrix();
      if (typeof engine.setPaused === 'function') {
        engine.setPaused(false);
      } else {
        engine.paused = false;
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`  Error: ${slug}`, err);
      try {
        if (typeof engine.setPaused === 'function') engine.setPaused(false);
        else engine.paused = false;
      } catch {}
    }
  }

  console.log(`%cDone! Move PNGs to public/vrms/previews/`, 'font-weight:bold;color:#4fc3f7');
}

console.log('%c🎯 VRM Preview Capture ready', 'font-weight:bold;color:#4fc3f7');
console.log('Run: await captureAllPreviews()');
