/**
 * Renders the Eliza mark as a dense, interactive particle field shared by both
 * site layouts. Fixed SVG-mask homes preserve facial detail, a grouped opening
 * formation gives the mark a deliberate entrance, quiet home-space motion
 * keeps the settled face alive, and a compact cursor field bends nearby dots
 * without changing their color or opening a radial void.
 * Its mask-and-particle lineage comes from rauchg's v0 Logo particles template
 * through NubsCarson/reflow; the formation adapts Shaw's grouped face merge.
 */
(() => {
  const baseParticleCount = 8500;
  const referenceArea = 1440 * 1080;
  const formationMs = 1600;
  const fadeMs = 450;
  const fullTurn = Math.PI * 2;
  const activeFrameMs = 1000 / 60;
  const idleFrameMs = 1000 / 18;
  const driftAngularVelocity = fullTurn / 8200;
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
    let frame = 0;
    let idleTimer = 0;
    let resizeTimer = 0;
    let inView = true;
    let generation = 0;
    let hasBuilt = false;
    let forming = false;
    let born = 0;
    let lastFrame = 0;
    let restColor = "#ffffff";
    let pointerRadius = 120;
    let pointerShift = 14;
    let canvasLeft = 0;
    let canvasTop = 0;
    const pointer = {
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      clientX: 0,
      clientY: 0,
      active: false,
      down: false,
      flowX: 0.92,
      flowY: -0.39,
    };

    const clamp = (value, minimum, maximum) =>
      Math.min(maximum, Math.max(minimum, value));

    function markGeometry() {
      const edge = clamp(Math.min(width, height) * 0.045, 14, 46);
      let desiredSize;
      let desiredTop;
      let desiredLeft;
      if (width < 768) {
        const shortLandscape = height < 400;
        const shortPortrait = !shortLandscape && height < 720;
        desiredSize = Math.min(
          width * (shortLandscape ? 0.45 : shortPortrait ? 0.51 : 0.82),
          height * (shortLandscape ? 0.34 : shortPortrait ? 0.285 : 0.42),
        );
        desiredTop =
          shortLandscape || shortPortrait
            ? height * (shortLandscape ? 0.14 : 0.09)
            : (height - desiredSize) * 0.4;
        if (shortLandscape) desiredLeft = width * 0.78 - desiredSize * 0.5;
      } else if (height < 500) {
        desiredSize = Math.min(height * 0.9, width * 0.42);
        desiredTop = (height - desiredSize) * 0.5;
        desiredLeft = width * 0.7 - desiredSize * 0.5;
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

    function sampleHomes(geometry) {
      const maskSize = Math.max(1, Math.round(geometry.size));
      maskCanvas.width = maskSize;
      maskCanvas.height = maskSize;
      maskContext.clearRect(0, 0, maskSize, maskSize);
      maskContext.drawImage(image, 0, 0, maskSize, maskSize);
      const pixels = maskContext.getImageData(0, 0, maskSize, maskSize).data;
      const eligible = [];
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 128) eligible.push((index - 3) / 4);
      }
      if (!eligible.length)
        throw new Error("Eliza mark produced no particle targets");

      const targetCount = Math.min(
        eligible.length,
        Math.floor(
          baseParticleCount * Math.sqrt((width * height) / referenceArea),
        ),
      );
      const homes = [];
      for (let index = 0; index < targetCount; index += 1) {
        const selected =
          index + Math.floor(Math.random() * (eligible.length - index));
        [eligible[index], eligible[selected]] = [
          eligible[selected],
          eligible[index],
        ];
        const pixel = eligible[index];
        homes.push({
          x: geometry.left + (pixel % maskSize),
          y: geometry.top + Math.floor(pixel / maskSize),
        });
      }
      return homes;
    }

    function seedParticles(geometry, animateEntrance) {
      const faceX = geometry.left + geometry.size * 0.5;
      const faceY = geometry.top + geometry.size * 0.5;
      const groupSize = geometry.size / 3;
      const spread = clamp(geometry.size * 0.08, 24, 72);
      const motionScale = clamp(geometry.size / 600, 0.8, 1.3);

      particles = sampleHomes(geometry).map((home) => {
        const homeDeltaX = home.x - faceX;
        const homeDeltaY = home.y - faceY;
        const homeDistance = Math.hypot(homeDeltaX, homeDeltaY);
        let tangentX = 1;
        let tangentY = 0;
        if (homeDistance > 1) {
          tangentX = -homeDeltaY / homeDistance;
          tangentY = homeDeltaX / homeDistance;
        }
        const motionAmplitude = (0.45 + Math.random() * 0.65) * motionScale;
        const motionPhase =
          (home.x - geometry.left) * 0.021 +
          (home.y - geometry.top) * 0.015 +
          Math.random() * 0.35;
        const particle = {
          homeX: home.x,
          homeY: home.y,
          startX: home.x,
          startY: home.y,
          offsetX: 0,
          offsetY: 0,
          motionX: tangentX * motionAmplitude,
          motionY: tangentY * motionAmplitude,
          phaseSin: Math.sin(motionPhase),
          phaseCos: Math.cos(motionPhase),
          size: Math.random() + 0.5,
        };
        if (!animateEntrance) return particle;

        const column = clamp(
          Math.floor(((home.x - geometry.left) / geometry.size) * 3),
          0,
          2,
        );
        const row = clamp(
          Math.floor(((home.y - geometry.top) / geometry.size) * 3),
          0,
          2,
        );
        const groupX = geometry.left + (column + 0.5) * groupSize;
        const groupY = geometry.top + (row + 0.5) * groupSize;
        let outwardX = groupX - faceX;
        let outwardY = groupY - faceY;
        const outwardLength = Math.hypot(outwardX, outwardY);
        if (outwardLength < 1) {
          outwardX = 0;
          outwardY = -1;
        } else {
          outwardX /= outwardLength;
          outwardY /= outwardLength;
        }
        const originX = groupX + outwardX * geometry.size * 0.14;
        const originY = groupY + outwardY * geometry.size * 0.14;
        const angle = Math.random() * fullTurn;
        const radius = spread * Math.sqrt(Math.random());

        particle.startX = originX + Math.cos(angle) * radius;
        particle.startY = originY + Math.sin(angle) * radius;
        return particle;
      });
    }

    function draw(now, delta) {
      const formation = forming ? clamp((now - born) / formationMs, 0, 1) : 1;
      const eased =
        formation *
        formation *
        formation *
        (formation * (formation * 6 - 15) + 10);
      const opacity = forming ? clamp((now - born) / fadeMs, 0, 1) : 1;
      const livingProgress = reducedMotion.matches
        ? 0
        : clamp((formation - 0.88) / 0.12, 0, 1);
      const livingMix =
        livingProgress *
        livingProgress *
        livingProgress *
        (livingProgress * (livingProgress * 6 - 15) + 10);
      const driftAngle = now * driftAngularVelocity;
      const driftSin = Math.sin(driftAngle);
      const driftCos = Math.cos(driftAngle);
      let moving = forming && formation < 1;
      if (formation === 1) forming = false;

      if (pointer.active) {
        const pointerResponse = 1 - Math.exp(-10 * delta);
        const pointerErrorX = pointer.targetX - pointer.x;
        const pointerErrorY = pointer.targetY - pointer.y;
        pointer.x += pointerErrorX * pointerResponse;
        pointer.y += pointerErrorY * pointerResponse;
        if (Math.abs(pointerErrorX) + Math.abs(pointerErrorY) > 0.05)
          moving = true;
      }

      const offsetResponse =
        1 - Math.exp(-(pointer.active ? 7.5 : 4.5) * delta);
      const activeShift = pointer.down ? (width < 768 ? 16 : 20) : pointerShift;
      const acrossRadius = pointerRadius * 0.72;

      context.clearRect(0, 0, width, height);
      context.fillStyle = restColor;
      context.globalAlpha = opacity * opacity * (3 - 2 * opacity);
      context.beginPath();

      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const wave =
          driftSin * particle.phaseCos + driftCos * particle.phaseSin;
        const orbit =
          driftCos * particle.phaseCos - driftSin * particle.phaseSin;
        const baseX =
          particle.startX +
          (particle.homeX - particle.startX) * eased +
          (particle.motionX * wave - particle.motionY * orbit * 0.22) *
            livingMix;
        const baseY =
          particle.startY +
          (particle.homeY - particle.startY) * eased +
          (particle.motionY * wave + particle.motionX * orbit * 0.22) *
            livingMix;
        let desiredX = 0;
        let desiredY = 0;

        if (pointer.active && !reducedMotion.matches) {
          const dx = baseX - pointer.x;
          const dy = baseY - pointer.y;
          const along = dx * pointer.flowX + dy * pointer.flowY;
          const across = -dx * pointer.flowY + dy * pointer.flowX;
          const normalizedAlong = along / pointerRadius;
          const normalizedAcross = across / acrossRadius;
          const field =
            normalizedAlong * normalizedAlong +
            normalizedAcross * normalizedAcross;
          if (field < 3.2) {
            const bend = activeShift * Math.exp(-2.2 * field);
            const shear = 0.16 * Math.tanh(across / (pointerRadius * 0.45));
            desiredX = bend * (pointer.flowX - pointer.flowY * shear);
            desiredY = bend * (pointer.flowY + pointer.flowX * shear);
          }
        }

        const offsetErrorX = desiredX - particle.offsetX;
        const offsetErrorY = desiredY - particle.offsetY;
        particle.offsetX += offsetErrorX * offsetResponse;
        particle.offsetY += offsetErrorY * offsetResponse;
        if (
          desiredX === 0 &&
          desiredY === 0 &&
          Math.abs(particle.offsetX) + Math.abs(particle.offsetY) < 0.02
        ) {
          particle.offsetX = 0;
          particle.offsetY = 0;
        } else if (Math.abs(offsetErrorX) + Math.abs(offsetErrorY) > 0.02) {
          moving = true;
        }

        const x = baseX + particle.offsetX;
        const y = baseY + particle.offsetY;
        const radius = particle.size * 0.5;
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, fullTurn);
      }

      context.fill();
      context.globalAlpha = 1;
      return moving;
    }

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      if (idleTimer) clearTimeout(idleTimer);
      frame = 0;
      idleTimer = 0;
    }

    function wakeIdle() {
      idleTimer = 0;
      if (
        frame ||
        reducedMotion.matches ||
        document.hidden ||
        !inView ||
        !particles.length
      )
        return;
      renderTick(performance.now());
    }

    function renderTick(now) {
      const delta = Math.min((now - lastFrame) / 1000, 0.05);
      lastFrame = now;
      const moving = draw(now, delta);
      if (reducedMotion.matches || document.hidden || !inView) return;
      if (moving) frame = requestAnimationFrame(loop);
      else idleTimer = setTimeout(wakeIdle, idleFrameMs);
    }

    function loop(now) {
      frame = 0;
      if (now - lastFrame < activeFrameMs - 1) {
        frame = requestAnimationFrame(loop);
        return;
      }
      renderTick(now);
    }

    function start() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = 0;
      }
      if (
        frame ||
        reducedMotion.matches ||
        document.hidden ||
        !inView ||
        !particles.length
      )
        return;
      lastFrame = performance.now();
      frame = requestAnimationFrame(loop);
    }

    function cacheCanvasBounds() {
      const bounds = canvas.getBoundingClientRect();
      canvasLeft = bounds.left;
      canvasTop = bounds.top;
      if (pointer.active) {
        pointer.targetX = pointer.clientX - canvasLeft;
        pointer.targetY = pointer.clientY - canvasTop;
      }
      return bounds;
    }

    async function rebuild(expectedGeneration = generation) {
      await image.decode();
      if (expectedGeneration !== generation) return;
      stop();
      const bounds = cacheCanvasBounds();
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      const pixelRatio = Math.min(devicePixelRatio, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      restColor =
        getComputedStyle(canvas).getPropertyValue("--particle-rest").trim() ||
        "#ffffff";
      pointerRadius = clamp(Math.min(width, height) * 0.13, 72, 120);
      pointerShift = width < 768 ? 10 : 14;
      const animateEntrance = !hasBuilt && !reducedMotion.matches;
      seedParticles(markGeometry(), animateEntrance);
      if (pointer.active) {
        pointer.x = pointer.targetX;
        pointer.y = pointer.targetY;
      }
      hasBuilt = true;
      forming = animateEntrance;
      born = performance.now();
      draw(born, 1 / 60);
      start();
    }

    function updatePointer(event) {
      pointer.clientX = event.clientX;
      pointer.clientY = event.clientY;
      const x = event.clientX - canvasLeft;
      const y = event.clientY - canvasTop;
      if (pointer.active) {
        const movementX = x - pointer.targetX;
        const movementY = y - pointer.targetY;
        const movement = Math.hypot(movementX, movementY);
        if (movement > 1) {
          pointer.flowX = pointer.flowX * 0.78 + (movementX / movement) * 0.22;
          pointer.flowY = pointer.flowY * 0.78 + (movementY / movement) * 0.22;
          const flowLength = Math.hypot(pointer.flowX, pointer.flowY);
          pointer.flowX /= flowLength;
          pointer.flowY /= flowLength;
        }
      } else {
        pointer.x = x;
        pointer.y = y;
      }
      pointer.targetX = x;
      pointer.targetY = y;
      pointer.active = true;
      start();
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
        else start();
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
    addEventListener(
      "scroll",
      () => {
        cacheCanvasBounds();
        if (pointer.active) start();
      },
      { passive: true, capture: true },
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
