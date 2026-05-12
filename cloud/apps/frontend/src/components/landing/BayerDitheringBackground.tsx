"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

// Maximum number of simultaneous clicks/ripples
const MAX_CLICKS = 10;

// Click data structure
interface ClickData {
  position: THREE.Vector2;
  time: number;
}

// Shader uniforms
type ShaderUniforms = NonNullable<THREE.ShaderMaterialParameters["uniforms"]> & {
  uResolution: { value: THREE.Vector2 };
  uTime: { value: number };
  uClickPos: { value: THREE.Vector2[] };
  uClickTimes: { value: number[] };
  uMousePos: { value: THREE.Vector2 };
};

// Vertex shader - simple pass-through
const vertexShader = `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

// Fragment shader with Bayer dithering - based on reference code
const fragmentShader = `
  uniform vec2 uResolution;
  uniform float uTime;
  uniform vec2 uClickPos[${MAX_CLICKS}];
  uniform float uClickTimes[${MAX_CLICKS}];
  uniform vec2 uMousePos;
  
  // Constants - larger pixel size for sparser pattern
  const float PIXEL_SIZE = 1.5;
  const float CELL_PIXEL_SIZE = 6.0 * PIXEL_SIZE;
  
  // Bayer dithering functions
  float Bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }
  
  float Bayer4(vec2 a) {
    return Bayer2(0.5 * a) * 0.25 + Bayer2(a);
  }
  
  float Bayer8(vec2 a) {
    return Bayer4(0.5 * a) * 0.25 + Bayer2(a);
  }
  
  // FBM noise for base pattern
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p * frequency);
      frequency *= 2.0;
      amplitude *= 0.5;
    }
    
    return value;
  }
  
  void main() {
    // Use gl_FragCoord for pixel-perfect positioning
    vec2 fragCoord = gl_FragCoord.xy - uResolution * 0.5;
    float aspectRatio = uResolution.x / uResolution.y;
    
    // Calculate pixel and cell IDs
    float pixelSize = PIXEL_SIZE;
    vec2 pixelId = floor(fragCoord / pixelSize);
    float cellPixelSize = CELL_PIXEL_SIZE;
    vec2 cellId = floor(fragCoord / cellPixelSize);
    vec2 cellCoord = cellId * cellPixelSize;
    
    // UV coordinates for the grid
    vec2 uv = ((cellCoord / uResolution)) * vec2(aspectRatio, 1.0);
    
    // Create base pattern using fbm noise (organic clusters) - less dense
    float basePattern = fbm(uv * 5.0 + uTime * 0.05);
    
    // Wave parameters
    const float speed = 0.30;
    const float thickness = 0.10;
    const float dampT = 1.0;
    const float dampR = 1.0;
    
    // Calculate feed from click interactions
    float feed = 0.0;
    for (int i = 0; i < ${MAX_CLICKS}; i++) {
      vec2 pos = uClickPos[i];
      if (pos.x < 0.0 && pos.y < 0.0) continue;
      
      // Convert click position to UV space
      vec2 cuv = (((pos - uResolution * 0.5 - cellPixelSize * 0.5) / uResolution)) * vec2(aspectRatio, 1.0);
      
      float t = max(uTime - uClickTimes[i], 0.0);
      float r = distance(uv, cuv);
      
      float waveR = speed * t;
      float ring = exp(-pow((r - waveR) / thickness, 2.0));
      float atten = exp(-dampT * t) * exp(-dampR * r);
      
      feed = max(feed, ring * atten);
    }
    
    // Calculate feed from mouse cursor position (continuous interaction)
    float mouseFeed = 0.0;
    if (uMousePos.x >= 0.0 && uMousePos.y >= 0.0) {
      // Convert mouse position to UV space
      vec2 muv = (((uMousePos - uResolution * 0.5 - cellPixelSize * 0.5) / uResolution)) * vec2(aspectRatio, 1.0);
      float mouseDist = distance(uv, muv);
      
      // Create a glow effect around cursor (smaller, more subtle than clicks)
      const float mouseRadius = 0.15;
      const float mouseIntensity = 0.15;
      mouseFeed = exp(-pow(mouseDist / mouseRadius, 2.0)) * mouseIntensity;
    }
    
    // Bayer dithering value (ranges from -0.5 to 0.5)
    float bayerValue = Bayer8(fragCoord / pixelSize) - 0.5;
    
    // Combine base pattern, feed, and bayer to create final pattern
    // basePattern ranges 0-1, creates organic clusters
    // bayerValue ranges -0.5 to 0.5, we normalize it to 0-1 range
    // feed adds to pattern when clicking
    // mouseFeed adds continuous interaction from cursor movement
    float normalizedBayer = (bayerValue + 0.5); // Now ranges 0-1
    // Reduced contributions to make pattern less dense, but still visible
    // Reduced feed contribution to make interactive waves less dense
    float pattern = basePattern * 0.25 + normalizedBayer * 0.35 + feed * 0.2 + mouseFeed * 0.5;
    
    // Threshold adjusted to show sparse pattern but keep most space black
    // Black background (0.0), orange pattern (1.0)
    float bw = step(0.51, pattern);
    
    // Black background, orange pattern and waves (#ff5800)
    vec3 orangeColor = vec3(1.0, 0.345, 0.0); // #ff5800
    vec3 blackColor = vec3(0.0, 0.0, 0.0);
    vec3 color = mix(blackColor, orangeColor, bw);
    
    gl_FragColor = vec4(color, 1.0);
  }
`;

// Shader material component
function BayerDitheringMaterial({
  resolution,
  clicks,
  mousePos,
  onTimeUpdate,
}: {
  resolution: THREE.Vector2;
  clicks: ClickData[];
  mousePos: THREE.Vector2;
  onTimeUpdate?: (time: number) => void;
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // Use useMemo to create stable uniforms object that can be passed during render
  const uniforms = useMemo<ShaderUniforms>(
    () => ({
      uResolution: { value: resolution.clone() },
      uTime: { value: 0 },
      uClickPos: {
        value: Array(MAX_CLICKS)
          .fill(null)
          .map(() => new THREE.Vector2(-1, -1)),
      },
      uClickTimes: { value: Array(MAX_CLICKS).fill(-1) },
      uMousePos: { value: new THREE.Vector2(-1, -1) },
    }),
    [resolution.clone], // Only create once - we update values in useFrame
  );

  // Update resolution when it changes
  useEffect(() => {
    uniforms.uResolution.value.copy(resolution);
  }, [resolution, uniforms]);

  // Update mouse position when it changes
  useEffect(() => {
    uniforms.uMousePos.value.copy(mousePos);
  }, [mousePos, uniforms]);

  useFrame((state) => {
    if (materialRef.current) {
      const currentTime = state.clock.elapsedTime;
      uniforms.uTime.value = currentTime;

      // Notify parent of current time
      if (onTimeUpdate) {
        onTimeUpdate(currentTime);
      }

      // Update click positions and times
      for (let i = 0; i < MAX_CLICKS; i++) {
        if (i < clicks.length) {
          uniforms.uClickPos.value[i].copy(clicks[i].position);
          uniforms.uClickTimes.value[i] = clicks[i].time;
        } else {
          uniforms.uClickPos.value[i].set(-1, -1);
          uniforms.uClickTimes.value[i] = -1;
        }
      }
    }
  });

  return (
    <shaderMaterial
      ref={materialRef}
      vertexShader={vertexShader}
      fragmentShader={fragmentShader}
      uniforms={uniforms}
    />
  );
}

// Main component
interface BayerDitheringBackgroundProps {
  className?: string;
}

export default function BayerDitheringBackground({
  className = "",
}: BayerDitheringBackgroundProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState(
    typeof window !== "undefined"
      ? new THREE.Vector2(window.innerWidth, window.innerHeight)
      : new THREE.Vector2(1920, 1080),
  );
  const [clicks, setClicks] = useState<ClickData[]>([]);
  const [mousePos, setMousePos] = useState<THREE.Vector2>(new THREE.Vector2(-1, -1));
  const clickIndexRef = useRef(0);
  const currentTimeRef = useRef<number>(0);

  useEffect(() => {
    const handleResize = () => {
      setResolution(new THREE.Vector2(window.innerWidth, window.innerHeight));
    };

    const handleClick = (event: MouseEvent) => {
      if (!canvasRef.current) return;

      const canvas = canvasRef.current.querySelector("canvas");
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      // Get click position in CSS pixels
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;

      // Convert to frame-buffer pixels (handles Hi-DPI screens)
      const fragX = cssX * (canvas.width / rect.width);
      const fragY = (rect.height - cssY) * (canvas.height / rect.height);

      // Use the current clock time from the shader
      const clickTime = currentTimeRef.current;
      const newClick: ClickData = {
        position: new THREE.Vector2(fragX, fragY),
        time: clickTime,
      };

      setClicks((prev) => {
        const updated = [...prev, newClick].slice(-MAX_CLICKS);
        clickIndexRef.current = (clickIndexRef.current + 1) % MAX_CLICKS;
        return updated;
      });
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!canvasRef.current) return;

      const canvas = canvasRef.current.querySelector("canvas");
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      // Get mouse position in CSS pixels
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;

      // Convert to frame-buffer pixels (handles Hi-DPI screens)
      const fragX = cssX * (canvas.width / rect.width);
      const fragY = (rect.height - cssY) * (canvas.height / rect.height);

      setMousePos(new THREE.Vector2(fragX, fragY));
    };

    const handleMouseLeave = () => {
      // Reset mouse position when cursor leaves the canvas
      setMousePos(new THREE.Vector2(-1, -1));
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("click", handleClick);
    window.addEventListener("mousemove", handleMouseMove);

    // Capture ref value to avoid stale closure in cleanup
    const canvasElement = canvasRef.current;

    // Attach mouseleave to the canvas div element
    if (canvasElement) {
      canvasElement.addEventListener("mouseleave", handleMouseLeave);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("click", handleClick);
      window.removeEventListener("mousemove", handleMouseMove);
      if (canvasElement) {
        canvasElement.removeEventListener("mouseleave", handleMouseLeave);
      }
    };
  }, []);

  return (
    <div
      ref={canvasRef}
      className={`fixed inset-0 ${className}`}
      style={{
        width: "100vw",
        height: "100vh",
      }}
    >
      <Canvas
        gl={{ preserveDrawingBuffer: true, antialias: false }}
        camera={{ position: [0, 0, 1], fov: 75 }}
        style={{
          display: "block",
          width: "100vw",
          height: "100vh",
        }}
        dpr={[1, 2]}
      >
        <mesh>
          <planeGeometry args={[2, 2]} />
          <BayerDitheringMaterial
            resolution={resolution}
            clicks={clicks}
            mousePos={mousePos}
            onTimeUpdate={(time) => {
              currentTimeRef.current = time;
            }}
          />
        </mesh>
      </Canvas>
    </div>
  );
}
