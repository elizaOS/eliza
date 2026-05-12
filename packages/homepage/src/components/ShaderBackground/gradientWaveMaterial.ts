import { shaderMaterial } from "@react-three/drei";
import { extend, type ThreeElement } from "@react-three/fiber";
import * as THREE from "three";

const GradientWaveMaterial = shaderMaterial(
  {
    uTime: 0,
    uMouse: new THREE.Vector2(0.5, 0.5),
    uMouseVel: new THREE.Vector2(0, 0),
    uClickTime: 100,
    uClickPos: new THREE.Vector2(0.5, 0.5),
    uResolution: new THREE.Vector2(1, 1),
  },
  /* vertex shader */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  /* fragment shader */ `
    precision highp float;

    uniform float uTime;
    uniform vec2 uMouse;
    uniform vec2 uMouseVel;
    uniform float uClickTime;
    uniform vec2 uClickPos;
    uniform vec2 uResolution;

    varying vec2 vUv;

    // Simplex-style hash
    vec2 hash(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)),
               dot(p, vec2(269.5, 183.3)));
      return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
    }

    // Gradient noise
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);

      return mix(mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
                     dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
                 mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
                     dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
    }

    // Fractal Brownian Motion
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
      vec2 uv = vUv;
      float aspect = uResolution.x / uResolution.y;
      float pScale = 1.4;
      vec2 p = vec2(uv.x * aspect, uv.y) * pScale;

      // Click — expanding ring of scale distortion (no snap: ring starts at r=0)
      vec2 clickNorm = vec2(uClickPos.x * aspect, uClickPos.y) * pScale;
      vec2 toClick = p - clickNorm;
      float clickDist = length(toClick);
      float age = uClickTime;
      float ringRadius = age * 0.7;
      float ringThickness = 0.08 + age * 0.03;
      float ring = exp(-pow((clickDist - ringRadius) / ringThickness, 2.0));
      float fade = exp(-age * 2.5);
      float radiusFade = 1.0 / (1.0 + ringRadius * 3.0);
      float scale = 1.0 + ring * fade * radiusFade * 1.2;
      p = clickNorm + toClick * scale;

      // Mouse — inner zone flows with cursor, outer zone parts radially
      vec2 mouseNorm = vec2(uMouse.x * aspect, uMouse.y) * pScale;
      vec2 vel = vec2(uMouseVel.x * aspect, uMouseVel.y) * pScale;
      float speed = length(vel);
      vec2 toPoint = p - mouseNorm;
      float mouseDist = length(toPoint);

      // Inner: gaussian falloff, no hard edge
      float inner = exp(-mouseDist * mouseDist / 0.008);
      vec2 flow = vel * inner * 0.2;

      // Outer: wider gaussian for radial push
      float outer = exp(-mouseDist * mouseDist / 0.025);
      vec2 radialPush = normalize(toPoint + 0.001) * outer * min(speed, 2.0) * 0.06;

      vec2 warp = flow + radialPush;

      // Time-evolving coordinates — circular paths so it morphs in place, no drift
      float t = uTime * 0.1;
      vec2 drift1 = vec2(sin(t * 0.7) * 0.4, cos(t * 0.5) * 0.4);
      vec2 drift2 = vec2(cos(t * 0.6) * 0.3, sin(t * 0.8) * 0.3);
      vec2 drift3 = vec2(sin(t * 0.9) * 0.35, cos(t * 1.1) * 0.25);

      vec2 q = vec2(fbm(p + warp + drift1),
                     fbm(p + warp + vec2(5.2, 1.3) + drift2));

      vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + drift2 * 0.5),
                     fbm(p + 4.0 * q + vec2(8.3, 2.8) + drift1 * 0.3));

      vec2 s = vec2(fbm(p + 3.0 * r + vec2(3.4, 7.1) + drift3),
                     fbm(p + 3.0 * r + vec2(6.7, 4.3) + drift1 * 0.4));

      float f = fbm(p + 4.0 * s);

      // Soft pastel palette — lighter but still visible
      vec3 col1 = vec3(0.94, 0.92, 0.98);  // light lavender
      vec3 col2 = vec3(0.65, 0.75, 0.95);  // soft blue
      vec3 col3 = vec3(0.88, 0.60, 0.80);  // soft pink
      vec3 col4 = vec3(0.55, 0.85, 0.82);  // soft teal
      vec3 col5 = vec3(0.96, 0.72, 0.58);  // soft peach

      float ff = clamp((f + 0.5) * 0.7, 0.0, 1.0);
      vec3 color = mix(col1, col2, ff);
      color = mix(color, col3, clamp(length(q) * 0.8, 0.0, 1.0));
      color = mix(color, col4, clamp(abs(r.x) * 0.6, 0.0, 1.0));
      color = mix(color, col5, clamp(abs(r.y) * 0.5, 0.0, 1.0));
      color = mix(color, col3, clamp(abs(s.x) * 0.4, 0.0, 1.0));
      color = mix(color, col4, clamp(abs(s.y) * 0.3, 0.0, 1.0));

      gl_FragColor = vec4(color, 1.0);
    }
  `,
);

extend({ GradientWaveMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    gradientWaveMaterial: ThreeElement<typeof GradientWaveMaterial>;
  }
}

export { GradientWaveMaterial };
