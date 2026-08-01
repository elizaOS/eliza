/**
 * Full-viewport WebGL shader background for the homepage onboarding flow.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import "./gradientWaveMaterial";

function ShaderPlane({ interactive }: { interactive: boolean }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const mouseRaw = useRef(new THREE.Vector2(0.5, 0.5));
  const mouseSmooth = useRef(new THREE.Vector2(0.5, 0.5));
  const mouseVel = useRef(new THREE.Vector2(0, 0));
  const velSmooth = useRef(new THREE.Vector2(0, 0));
  const previousMouse = useRef(new THREE.Vector2(0.5, 0.5));
  const clickPos = useRef(new THREE.Vector2(0.5, 0.5));
  const clickTime = useRef(100);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (!interactive) return;

    const onMove = (e: PointerEvent) => {
      mouseRaw.current.set(
        e.clientX / window.innerWidth,
        1 - e.clientY / window.innerHeight,
      );
      invalidate();
    };
    const onDown = (e: PointerEvent) => {
      clickPos.current.set(
        e.clientX / window.innerWidth,
        1 - e.clientY / window.innerHeight,
      );
      clickTime.current = 0;
      invalidate();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [interactive, invalidate]);

  useFrame((_state, delta) => {
    const mat = matRef.current;
    if (!mat) return;

    mat.uniforms.uTime.value = _state.clock.elapsedTime;
    mat.uniforms.uResolution.value.set(
      _state.gl.domElement.clientWidth,
      _state.gl.domElement.clientHeight,
    );
    mat.uniforms.uClickPos.value.copy(clickPos.current);

    previousMouse.current.copy(mouseSmooth.current);
    mouseSmooth.current.lerp(mouseRaw.current, 0.08);
    mat.uniforms.uMouse.value.copy(mouseSmooth.current);

    const safeDelta = Math.max(delta, 0.001);
    mouseVel.current.set(
      (mouseSmooth.current.x - previousMouse.current.x) / safeDelta,
      (mouseSmooth.current.y - previousMouse.current.y) / safeDelta,
    );
    velSmooth.current.lerp(mouseVel.current, 0.1);
    mat.uniforms.uMouseVel.value.copy(velSmooth.current);

    clickTime.current += delta;
    mat.uniforms.uClickTime.value = clickTime.current;
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <gradientWaveMaterial ref={matRef} />
    </mesh>
  );
}

function ShaderFrameDriver({ reducedMotion }: { reducedMotion: boolean }) {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (reducedMotion) {
      invalidate();
      return;
    }

    let animationFrame = 0;
    let previousFrame = 0;
    const frameInterval = 1000 / 30;
    const tick = (now: number) => {
      if (now - previousFrame >= frameInterval) {
        previousFrame = now;
        invalidate();
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [invalidate, reducedMotion]);

  return null;
}

export default function ShaderBackground() {
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 1] }}
        dpr={1}
        frameloop="demand"
        gl={{
          alpha: false,
          antialias: false,
          powerPreference: "high-performance",
        }}
        style={{ pointerEvents: reducedMotion ? "none" : "auto" }}
      >
        <ShaderPlane interactive={!reducedMotion} />
        <ShaderFrameDriver reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
