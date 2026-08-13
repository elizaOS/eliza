/**
 * Renders the Eliza mark with the particle behavior from NubsCarson/reflow's
 * Cool component. Both pages share the same mask geometry, density, shimmer,
 * pointer scatter, and return timing; only their CSS colors differ. The SVG is
 * decoded into a private alpha mask, so only particles reach the visible canvas.
 */
(() => {
  const baseParticleCount = 8500;
  const referenceArea = 1440 * 1080;
  const maxDistance = 240;
  const scatterDistance = 60;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  for (const canvas of document.querySelectorAll(
    "canvas[data-particle-logo]",
  )) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Particle canvas is unavailable");

    const maskCanvas = document.createElement("canvas");
    const maskContext = maskCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!maskContext) throw new Error("Particle mask canvas is unavailable");

    const image = new Image();
    image.decoding = "async";
    image.src = canvas.dataset.particleLogo;

    let width = 0;
    let height = 0;
    let particles = [];
    let homes = [];
    let frame = 0;
    let resizeTimer = 0;
    let inView = true;
    let generation = 0;
    let restColor = "#ffffff";
    let scatterColor = "#ffd2bd";
    const pointer = { x: -9999, y: -9999, active: false, down: false };

    const clamp = (value, minimum, maximum) =>
      Math.min(maximum, Math.max(minimum, value));

    function markGeometry() {
      const edge = clamp(Math.min(width, height) * 0.045, 14, 46);
      let desiredSize;
      let desiredTop;
      let desiredLeft;
      if (width < 768) {
        const shortLandscape = height < 400;
        desiredSize = Math.min(
          width * (shortLandscape ? 0.45 : 0.82),
          height * (shortLandscape ? 0.34 : 0.42),
        );
        desiredTop = shortLandscape
          ? height * 0.14
          : (height - desiredSize) * 0.48;
      } else if (height < 500) {
        desiredSize = Math.min(height * 0.9, width * 0.42);
        desiredTop = (height - desiredSize) * 0.5;
        desiredLeft = width * 0.62 - desiredSize * 0.5;
      } else {
        desiredSize = Math.min(height * 0.94, width * 0.96);
        desiredTop = (height - desiredSize) * 0.5;
      }

      const size = Math.min(desiredSize, width - edge * 2, height - edge * 2);
      const left = clamp(
        desiredLeft ?? (width - size) * 0.5,
        edge,
        width - size - edge,
      );
      const top = clamp(desiredTop, edge, height - size - edge);
      return { left, top, size };
    }

    function sampleHomes() {
      const geometry = markGeometry();
      const maskSize = Math.max(1, Math.round(geometry.size));
      maskCanvas.width = maskSize;
      maskCanvas.height = maskSize;
      maskContext.clearRect(0, 0, maskSize, maskSize);
      maskContext.drawImage(image, 0, 0, maskSize, maskSize);
      const pixels = maskContext.getImageData(0, 0, maskSize, maskSize).data;
      const nextHomes = [];
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 128) {
          const pixel = (index - 3) / 4;
          nextHomes.push({
            x: geometry.left + (pixel % maskSize),
            y: geometry.top + Math.floor(pixel / maskSize),
          });
        }
      }
      if (!nextHomes.length)
        throw new Error("Eliza mark produced no particle targets");
      return nextHomes;
    }

    function createParticle() {
      const home = homes[Math.floor(Math.random() * homes.length)];
      return {
        x: home.x,
        y: home.y,
        baseX: home.x,
        baseY: home.y,
        size: Math.random() + 0.5,
        life: Math.random() * 100 + 50,
      };
    }

    function seedParticles() {
      const count = Math.floor(
        baseParticleCount * Math.sqrt((width * height) / referenceArea),
      );
      particles = Array.from({ length: count }, createParticle);
    }

    function draw(animate) {
      context.clearRect(0, 0, width, height);
      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const dx = pointer.x - particle.x;
        const dy = pointer.y - particle.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (pointer.active && distance < maxDistance) {
          const force = (maxDistance - distance) / maxDistance;
          const angle = Math.atan2(dy, dx);
          particle.x =
            particle.baseX - Math.cos(angle) * force * scatterDistance;
          particle.y =
            particle.baseY - Math.sin(angle) * force * scatterDistance;
          context.fillStyle = scatterColor;
        } else {
          particle.x += (particle.baseX - particle.x) * 0.1;
          particle.y += (particle.baseY - particle.y) * 0.1;
          context.fillStyle = restColor;
        }
        context.fillRect(particle.x, particle.y, particle.size, particle.size);

        if (animate) {
          particle.life -= 1;
          if (particle.life <= 0) particles[index] = createParticle();
        }
      }
    }

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function loop() {
      draw(true);
      frame = requestAnimationFrame(loop);
    }

    function start() {
      if (
        frame ||
        reducedMotion.matches ||
        document.hidden ||
        !inView ||
        !particles.length
      )
        return;
      frame = requestAnimationFrame(loop);
    }

    async function rebuild(expectedGeneration = generation) {
      await image.decode();
      if (expectedGeneration !== generation) return;
      stop();
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      canvas.width = width;
      canvas.height = height;
      const style = getComputedStyle(canvas);
      restColor = style.getPropertyValue("--particle-rest").trim() || "#ffffff";
      scatterColor =
        style.getPropertyValue("--particle-scatter").trim() || "#ffd2bd";
      homes = sampleHomes();
      seedParticles();
      draw(false);
      start();
    }

    function updatePointer(event) {
      const bounds = canvas.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
      start();
    }

    function resetPointer() {
      pointer.x = -9999;
      pointer.y = -9999;
      pointer.active = false;
      pointer.down = false;
      start();
    }

    function reportRebuildFailure(cause) {
      // error-policy:J2 The browser boundary preserves the decode/draw cause.
      throw new Error("Particle logo could not render", { cause });
    }

    function requestRebuild() {
      void rebuild(++generation).catch(reportRebuildFailure);
    }

    document.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType === "touch" && !pointer.down) return;
        updatePointer(event);
      },
      { passive: true },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        pointer.down = true;
        updatePointer(event);
      },
      { passive: true },
    );
    addEventListener(
      "pointerup",
      (event) => {
        pointer.down = false;
        if (event.pointerType === "touch") resetPointer();
      },
      { passive: true },
    );
    addEventListener("pointercancel", resetPointer, { passive: true });
    document.addEventListener("mouseleave", resetPointer, { passive: true });
    addEventListener(
      "resize",
      () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(requestRebuild, 140);
      },
      { passive: true },
    );
    document.addEventListener("visibilitychange", () =>
      document.hidden ? stop() : start(),
    );
    reducedMotion.addEventListener("change", requestRebuild);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        if (inView) start();
        else stop();
      }).observe(canvas);
    }

    void rebuild().catch(reportRebuildFailure);
  }
})();
