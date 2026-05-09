import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import "./gradientWaveMaterial";

function ShaderPlane() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const mouseRaw = useRef(new THREE.Vector2(0.5, 0.5));
  const mouseSmooth = useRef(new THREE.Vector2(0.5, 0.5));
  const mouseVel = useRef(new THREE.Vector2(0, 0));
  const velSmooth = useRef(new THREE.Vector2(0, 0));
  const clickPos = useRef(new THREE.Vector2(0.5, 0.5));
  const clickTime = useRef(100);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouseRaw.current.set(
        e.clientX / window.innerWidth,
        1 - e.clientY / window.innerHeight,
      );
    };
    const onDown = (e: PointerEvent) => {
      clickPos.current.set(
        e.clientX / window.innerWidth,
        1 - e.clientY / window.innerHeight,
      );
      clickTime.current = 0;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  useFrame((_state, delta) => {
    const mat = matRef.current;
    if (!mat) return;

    mat.uniforms.uTime.value = _state.clock.elapsedTime;
    mat.uniforms.uResolution.value.set(
      _state.gl.domElement.clientWidth,
      _state.gl.domElement.clientHeight,
    );
    mat.uniforms.uClickPos.value.copy(clickPos.current);

    // Smooth the mouse position so it trails behind the cursor
    const prev = mouseSmooth.current.clone();
    mouseSmooth.current.lerp(mouseRaw.current, 0.08);
    mat.uniforms.uMouse.value.copy(mouseSmooth.current);

    // Compute velocity from smoothed position delta
    const safeDelta = Math.max(delta, 0.001);
    mouseVel.current.set(
      (mouseSmooth.current.x - prev.x) / safeDelta,
      (mouseSmooth.current.y - prev.y) / safeDelta,
    );
    // Smooth velocity so it doesn't jitter
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

export default function ShaderBackground() {
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 1] }}
        dpr={[1, 1.5]}
        gl={{ alpha: false, antialias: false }}
        style={{ pointerEvents: "auto" }}
      >
        <ShaderPlane />
      </Canvas>
    </div>
  );
}
