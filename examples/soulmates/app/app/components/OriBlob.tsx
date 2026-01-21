"use client";

import { Environment, MeshTransmissionMaterial } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BufferGeometry, Mesh, NormalBufferAttributes } from "three";

interface BlobMeshProps {
  color?: string;
}

// Easing function for smooth intro animation
function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

function BlobMesh({ color: _color = "#ff3333" }: BlobMeshProps) {
  const meshRef = useRef<Mesh<BufferGeometry<NormalBufferAttributes>>>(null);
  const originalPositions = useRef<Float32Array | null>(null);
  const introProgress = useRef(0);
  const targetScale = 1;
  const introDuration = 1.2;

  const noise3D = useMemo(() => {
    return (x: number, y: number, z: number, time: number): number => {
      const t = time * 0.3;

      const lowFreq = 1.2;
      const lowLayer =
        Math.sin(x * lowFreq + t * 0.7) *
          Math.cos(z * lowFreq * 0.8 + t * 0.5) *
          0.4 +
        Math.sin(y * lowFreq * 1.1 + t * 0.6) * 0.3;

      const medFreq1 = 2.2;
      const medFreq2 = 3.5;
      const medLayer =
        Math.sin(y * medFreq1 + t * 0.9) *
          Math.cos(z * medFreq1 * 0.85 + t * 0.7) *
          0.7 +
        Math.sin(x * medFreq1 * 1.1 + t * 0.8) *
          Math.cos(y * medFreq1 * 0.9 + t * 0.6) *
          0.6 +
        Math.sin(z * medFreq2 + t * 1.0) *
          Math.cos(x * medFreq2 * 0.95 + t * 0.85) *
          0.5 +
        Math.sin((x + y) * medFreq2 * 0.8 + t * 0.75) * 0.4 +
        Math.sin((y - z) * medFreq1 * 1.2 + t * 0.65) * 0.35;

      const highFreq = 5.5;
      const highLayer =
        Math.sin((x + y) * highFreq + t * 1.1) * 0.2 +
        Math.sin((y + z) * highFreq * 1.05 + t * 0.95) * 0.15 +
        Math.sin((x - z) * highFreq * 0.9 + t * 1.2) * 0.1;

      return lowLayer + medLayer + highLayer;
    };
  }, []);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    const time = state.clock.elapsedTime;

    if (introProgress.current < 1) {
      introProgress.current = Math.min(
        1,
        introProgress.current + delta / introDuration,
      );
      const easedProgress = easeOutBack(introProgress.current);
      meshRef.current.scale.setScalar(easedProgress * targetScale);
    }

    const geometry = meshRef.current.geometry;
    const positionAttribute = geometry.getAttribute("position");

    if (!originalPositions.current) {
      originalPositions.current = new Float32Array(positionAttribute.array);
    }

    const positions = positionAttribute.array as Float32Array;
    const original = originalPositions.current;
    const noiseIntensity = Math.min(1, introProgress.current * 2) * 0.18;

    for (let i = 0; i < positions.length; i += 3) {
      const ox = original[i];
      const oy = original[i + 1];
      const oz = original[i + 2];
      const noiseValue = noise3D(ox, oy, oz, time);
      const length = Math.sqrt(ox * ox + oy * oy + oz * oz);

      if (length > 0) {
        const nx = ox / length;
        const ny = oy / length;
        const nz = oz / length;
        const displacement = noiseValue * noiseIntensity;
        positions[i] = ox + nx * displacement;
        positions[i + 1] = oy + ny * displacement;
        positions[i + 2] = oz + nz * displacement;
      }
    }

    positionAttribute.needsUpdate = true;
    geometry.computeVertexNormals();

    meshRef.current.rotation.y += 0.002;
    meshRef.current.rotation.x = Math.sin(time * 0.25) * 0.05;
  });

  return (
    <mesh ref={meshRef} scale={0}>
      <icosahedronGeometry args={[1, 128]} />
      <MeshTransmissionMaterial
        transmissionSampler
        color="#ffcccc"
        transmission={1}
        thickness={0.2}
        roughness={0}
        ior={2.4}
        chromaticAberration={0.1}
        distortion={0.5}
        distortionScale={0.8}
        temporalDistortion={0.2}
        backside
        backsideThickness={0.2}
        samples={16}
        resolution={1024}
        attenuationColor="#ff9999"
        attenuationDistance={10}
        envMapIntensity={5}
        toneMapped={false}
      />
    </mesh>
  );
}

interface OriBlobProps {
  className?: string;
}

export default function OriBlob({ className = "" }: OriBlobProps) {
  const [ready, setReady] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timeoutRef.current = setTimeout(() => {
      setReady(true);
    }, 100);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      setReady(false);
    };
  }, []);

  return (
    <div
      className={`relative ${className}`}
      style={{ width: "100%", height: "100%", minHeight: 320 }}
    >
      {/* Bloom glow layer */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          filter: "blur(50px)",
          opacity: 1,
          background:
            "radial-gradient(circle at center, rgba(220, 40, 40, 0.5) 0%, rgba(100, 0, 0, 0.2) 40%, transparent 10%)",
        }}
      />
      {ready && (
        <Canvas
          camera={{ position: [0, 0, 4], fov: 45 }}
          style={{ background: "#120808" }}
          gl={{
            antialias: true,
          }}
          dpr={2}
          onCreated={({ gl }) => {
            gl.setClearColor(0x120808, 1);
            const canvas = gl.domElement;
            canvas.addEventListener("webglcontextlost", (e) => {
              e.preventDefault();
            });
          }}
        >
          <BlobMesh color="#ff3333" />

          {/* Use studio preset for good lighting */}
          <Environment preset="studio" background={false} />

          {/* Add direct lights for extra brightness */}
          <directionalLight
            position={[5, 5, 5]}
            intensity={2}
            color="#ffffff"
          />
          <directionalLight
            position={[-5, 3, 3]}
            intensity={1.5}
            color="#fff5f5"
          />
          <ambientLight intensity={1} color="#ffffff" />
        </Canvas>
      )}
    </div>
  );
}
