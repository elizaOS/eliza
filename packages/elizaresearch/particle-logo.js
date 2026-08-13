/**
 * Renders the Eliza mark as a dense, interactive particle field for both site
 * pages. A quick clustered entrance resolves into unique SVG-mask targets, then
 * stable spring offsets provide Reflow-style pointer scatter without teleporting
 * dots or smearing the mark's fine facial detail. Only round dots reach the
 * visible canvas; the SVG is decoded into a private geometry canvas.
 * Cost: one same-origin SVG fetch/decode, O(n) active frames, and zero idle RAF.
 */
(() => {
  const referenceArea = 1440 * 1080;
  const formationMs = 2600;
  const fadeMs = 550;
  const tau = Math.PI * 2;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  for (const canvas of document.querySelectorAll(
    "canvas[data-particle-logo]",
  )) {
    const context = canvas.getContext("2d");
    const surface =
      canvas.closest("[data-particle-surface]") || canvas.parentElement;
    if (!context || !surface) throw new Error("Particle canvas is unavailable");

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
    let dpr = 1;
    let particles = [];
    let born = 0;
    let frame = 0;
    let lastTime = 0;
    let resizeTimer = 0;
    let inView = true;
    let generation = 0;
    let hasEntered = false;
    let pointerRadius = 160;
    let canvasBounds;
    let restColor = "#ffffff";
    let scatterColor = "#ffd2bd";
    const pointer = { x: -10000, y: -10000, active: false, down: false };

    const clamp = (value, minimum, maximum) =>
      Math.min(maximum, Math.max(minimum, value));

    function markGeometry() {
      const reflowLayout = canvas.dataset.particleLayout === "reflow";
      const edge = clamp(Math.min(width, height) * 0.045, 14, 46);
      let desiredSize;
      let desiredTop;
      if (reflowLayout && width < 768) {
        desiredSize = Math.min(width * 0.82, height * 0.42);
        desiredTop = (height - desiredSize) * 0.48;
      } else if (reflowLayout) {
        desiredSize = Math.min(height * 0.94, width * 0.96);
        desiredTop = (height - desiredSize) * 0.5;
      } else if (width < 900 && height < 650) {
        desiredSize = Math.min(width * 0.4, height * 0.2);
        desiredTop = 4.25 * 16;
      } else if (width < 900) {
        desiredSize = Math.min(width * 1.06, height * 0.66);
        desiredTop = (height - desiredSize) * 0.27;
      } else {
        desiredSize = Math.min(height * 0.98, width * 0.8);
        desiredTop = (height - desiredSize) * 0.38;
      }

      const size = Math.min(desiredSize, width - edge * 2, height - edge * 2);
      const left = clamp((width - size) * 0.5, edge, width - size - edge);
      const top = clamp(desiredTop, edge, height - size - edge);
      return { left, top, size };
    }

    function sampleHomes() {
      const geometry = markGeometry();
      const sampleScale = width < 768 ? 2 : 1.5;
      const maskSize = Math.max(1, Math.round(geometry.size * sampleScale));
      maskCanvas.width = maskSize;
      maskCanvas.height = maskSize;
      maskContext.clearRect(0, 0, maskSize, maskSize);
      maskContext.drawImage(image, 0, 0, maskSize, maskSize);
      const pixels = maskContext.getImageData(0, 0, maskSize, maskSize).data;
      const eligible = [];
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 48) eligible.push((index - 3) / 4);
      }
      if (!eligible.length)
        throw new Error("Eliza mark produced no particle targets");

      const requested = Math.floor(
        24000 * Math.sqrt((width * height) / referenceArea),
      );
      const count = Math.min(
        eligible.length,
        clamp(
          requested,
          width < 768 ? 8000 : 12000,
          width < 768 ? 12000 : 26000,
        ),
      );
      for (let index = 0; index < count; index += 1) {
        const swapIndex =
          index + Math.floor(Math.random() * (eligible.length - index));
        [eligible[index], eligible[swapIndex]] = [
          eligible[swapIndex],
          eligible[index],
        ];
      }

      const homes = eligible.slice(0, count).map((pixel) => ({
        x: geometry.left + (pixel % maskSize) / sampleScale,
        y: geometry.top + Math.floor(pixel / maskSize) / sampleScale,
      }));
      return { geometry, homes };
    }

    function seedParticles(geometry, homes, animateEntrance) {
      let minimumX = Infinity;
      let minimumY = Infinity;
      let maximumX = -Infinity;
      let maximumY = -Infinity;
      for (const home of homes) {
        minimumX = Math.min(minimumX, home.x);
        minimumY = Math.min(minimumY, home.y);
        maximumX = Math.max(maximumX, home.x);
        maximumY = Math.max(maximumY, home.y);
      }

      const origins = [];
      const spread = Math.min(180, geometry.size * 0.2);
      particles = homes.map((home) => {
        const column = Math.min(
          2,
          Math.floor(((home.x - minimumX) / (maximumX - minimumX + 1)) * 3),
        );
        const row = Math.min(
          2,
          Math.floor(((home.y - minimumY) / (maximumY - minimumY + 1)) * 3),
        );
        const group = row * 3 + column;
        origins[group] ||= {
          x: width * (0.5 + (Math.random() - 0.5) * 0.6),
          y:
            height < 650 && width < 768
              ? height * (0.16 + Math.random() * 0.1)
              : width < 768
                ? height * (0.2 + Math.random() * 0.28)
                : height * (0.5 + (Math.random() - 0.5) * 0.6),
        };
        const startX = animateEntrance
          ? origins[group].x + (Math.random() - 0.5) * spread
          : home.x;
        const startY = animateEntrance
          ? origins[group].y + (Math.random() - 0.5) * spread
          : home.y;
        return {
          x: startX,
          y: startY,
          startX,
          startY,
          home,
          offsetX: 0,
          offsetY: 0,
          radius: Math.random() < 0.75 ? 0.43 : 0.58,
          phase: Math.random() * tau,
          influence: 0,
        };
      });
    }

    function updateParticle(particle, delta, formation) {
      const baseX =
        particle.startX + (particle.home.x - particle.startX) * formation;
      const baseY =
        particle.startY + (particle.home.y - particle.startY) * formation;
      let desiredOffsetX = 0;
      let desiredOffsetY = 0;
      let desiredInfluence = 0;

      if (pointer.active) {
        const dx = baseX - pointer.x;
        const dy = baseY - pointer.y;
        const distanceSquared = dx * dx + dy * dy;
        const radiusSquared = pointerRadius * pointerRadius;
        if (distanceSquared < radiusSquared) {
          const distance = Math.sqrt(distanceSquared);
          const directionX =
            distance > 0.01 ? dx / distance : Math.cos(particle.phase);
          const directionY =
            distance > 0.01 ? dy / distance : Math.sin(particle.phase);
          const proximity = 1 - distanceSquared / radiusSquared;
          desiredInfluence = proximity * proximity;
          const push = desiredInfluence * (pointer.down ? 66 : 48);
          desiredOffsetX = directionX * push;
          desiredOffsetY = directionY * push;
        }
      }

      const offsetError =
        Math.abs(desiredOffsetX - particle.offsetX) +
        Math.abs(desiredOffsetY - particle.offsetY);
      const influenceError = Math.abs(desiredInfluence - particle.influence);
      const response = 1 - Math.exp(-(pointer.active ? 24 : 14) * delta);
      particle.offsetX += (desiredOffsetX - particle.offsetX) * response;
      particle.offsetY += (desiredOffsetY - particle.offsetY) * response;
      particle.influence += (desiredInfluence - particle.influence) * response;
      particle.x = baseX + particle.offsetX;
      particle.y = baseY + particle.offsetY;
      if (
        !pointer.active &&
        Math.abs(particle.offsetX) + Math.abs(particle.offsetY) < 0.03 &&
        particle.influence < 0.002
      ) {
        particle.offsetX = 0;
        particle.offsetY = 0;
        particle.influence = 0;
        particle.x = baseX;
        particle.y = baseY;
        return false;
      }
      return offsetError > 0.03 || influenceError > 0.002;
    }

    function addDot(particle) {
      context.moveTo(particle.x + particle.radius, particle.y);
      context.arc(particle.x, particle.y, particle.radius, 0, tau);
    }

    function draw(now, delta) {
      context.clearRect(0, 0, width, height);
      const rawFormation = reducedMotion.matches
        ? 1
        : clamp((now - born) / formationMs, 0, 1);
      const formation = rawFormation * rawFormation * (3 - 2 * rawFormation);
      context.globalAlpha = reducedMotion.matches
        ? 1
        : clamp((now - born) / fadeMs, 0, 1);

      let moving = rawFormation < 1;
      for (const particle of particles)
        moving = updateParticle(particle, delta, formation) || moving;
      context.beginPath();
      for (const particle of particles) addDot(particle);
      context.fillStyle = restColor;
      context.fill();

      context.beginPath();
      for (const particle of particles) {
        if (particle.influence > 0.02) addDot(particle);
      }
      context.fillStyle = scatterColor;
      context.fill();
      context.globalAlpha = 1;
      return moving;
    }

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function loop(now) {
      const delta = lastTime
        ? Math.min(0.034, (now - lastTime) / 1000)
        : 1 / 60;
      lastTime = now;
      if (draw(now, delta)) frame = requestAnimationFrame(loop);
      else frame = 0;
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
      lastTime = 0;
      frame = requestAnimationFrame(loop);
    }

    async function rebuild(expectedGeneration = generation) {
      await image.decode();
      if (expectedGeneration !== generation) return;
      stop();
      canvasBounds = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(canvasBounds.width));
      height = Math.max(1, Math.round(canvasBounds.height));
      pointerRadius = clamp(Math.min(width, height) * 0.2, 110, 190);
      dpr = Math.min(devicePixelRatio || 1, width < 768 ? 1.5 : 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const style = getComputedStyle(canvas);
      restColor = style.getPropertyValue("--particle-rest").trim() || "#ffffff";
      scatterColor =
        style.getPropertyValue("--particle-scatter").trim() || "#ffd2bd";
      const { geometry, homes } = sampleHomes();
      const animateEntrance = !hasEntered && !reducedMotion.matches;
      seedParticles(geometry, homes, animateEntrance);
      hasEntered = true;
      born = animateEntrance
        ? performance.now()
        : performance.now() - formationMs;
      draw(performance.now(), 1 / 60);
      start();
    }

    function updatePointer(event) {
      canvasBounds ||= canvas.getBoundingClientRect();
      pointer.x = event.clientX - canvasBounds.left;
      pointer.y = event.clientY - canvasBounds.top;
    }

    function resetPointer() {
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

    surface.addEventListener(
      "pointerenter",
      () => {
        canvasBounds = canvas.getBoundingClientRect();
      },
      { passive: true },
    );
    surface.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType === "touch" && !pointer.down) return;
        pointer.active = true;
        updatePointer(event);
        start();
      },
      { passive: true },
    );
    surface.addEventListener(
      "pointerdown",
      (event) => {
        pointer.active = true;
        pointer.down = true;
        updatePointer(event);
        start();
      },
      { passive: true },
    );
    addEventListener(
      "pointerup",
      (event) => {
        pointer.down = false;
        if (event.pointerType === "touch") resetPointer();
        else start();
      },
      { passive: true },
    );
    addEventListener("pointercancel", resetPointer, { passive: true });
    surface.addEventListener("pointerleave", resetPointer, { passive: true });
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
