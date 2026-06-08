import { useEffect, useRef } from "react";

export function WebGPUBg() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let active = true;
    let animationFrameId: number;
    let time = 0;

    // Track mouse position normalized to [-1, 1]
    const mouseRef = { x: -2, y: -2 };
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2.0 - 1.0;
      const y = -(((e.clientY - rect.top) / rect.height) * 2.0 - 1.0);
      mouseRef.x = x;
      mouseRef.y = y;
    };

    window.addEventListener("mousemove", handleMouseMove);

    // Resize handler
    const handleResize = () => {
      if (!canvas) return;
      canvas.width = canvas.clientWidth * window.devicePixelRatio;
      canvas.height = canvas.clientHeight * window.devicePixelRatio;
    };
    window.addEventListener("resize", handleResize);
    handleResize();

    // ── FALLBACK 2: Canvas 2D Particle Loop ──
    const runCanvas2DFallback = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const particleCount = 120;
      const particles: Array<{
        x: number;
        y: number;
        vx: number;
        vy: number;
        radius: number;
      }> = [];

      for (let i = 0; i < particleCount; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          radius: 1 + Math.random() * 1.5,
        });
      }

      const loop = () => {
        if (!active) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = "rgba(255, 88, 0, 0.08)";
        particles.forEach((p) => {
          p.x += p.vx;
          p.y += p.vy;

          if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
          if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

          // Mouse attraction/repulsion
          if (mouseRef.x > -2) {
            const mx = ((mouseRef.x + 1.0) / 2.0) * canvas.width;
            const my = ((-mouseRef.y + 1.0) / 2.0) * canvas.height;
            const dx = p.x - mx;
            const dy = p.y - my;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 150) {
              p.x += (dx / dist) * 0.5;
              p.y += (dy / dist) * 0.5;
            }
          }

          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fill();
        });

        animationFrameId = requestAnimationFrame(loop);
      };

      loop();
    };

    // ── FALLBACK 1: WebGL Flow Wave ──
    const runWebGLFallback = () => {
      const gl =
        canvas.getContext("webgl") ||
        (canvas.getContext("experimental-webgl") as WebGLRenderingContext);
      if (!gl) {
        runCanvas2DFallback();
        return;
      }

      const vertexShaderSource = `
        attribute vec2 position;
        varying vec2 vUv;
        void main() {
          vUv = position * 0.5 + 0.5;
          gl_Position = vec4(position, 0.0, 1.0);
        }
      `;

      const fragmentShaderSource = `
        precision mediump float;
        varying vec2 vUv;
        uniform float uTime;
        uniform vec2 uMouse;

        void main() {
          // Compute wave pattern
          vec2 center = vUv - vec2(0.5);
          float dist = length(center);
          float wave = sin(dist * 20.0 - uTime * 1.5) * 0.5 + 0.5;
          
          // Mouse interaction
          float mouseDist = length(vUv - (uMouse * 0.5 + 0.5));
          float glow = 0.0;
          if (mouseDist < 0.25) {
            glow = (1.0 - mouseDist / 0.25) * 0.2;
          }

          float brightness = wave * 0.02 * (1.0 - dist) + glow * 0.08;
          vec3 orangeColor = vec3(1.0, 0.35, 0.0);
          gl_FragColor = vec4(orangeColor * brightness, brightness * 0.25);
        }
      `;

      const compileShader = (source: string, type: number) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };

      const vs = compileShader(vertexShaderSource, gl.VERTEX_SHADER);
      const fs = compileShader(fragmentShaderSource, gl.FRAGMENT_SHADER);
      if (!vs || !fs) {
        runCanvas2DFallback();
        return;
      }

      const program = gl.createProgram();
      if (!program) {
        runCanvas2DFallback();
        return;
      }
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      const positionLocation = gl.getAttribLocation(program, "position");
      const timeLocation = gl.getUniformLocation(program, "uTime");
      const mouseLocation = gl.getUniformLocation(program, "uMouse");

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );

      const render = () => {
        if (!active) return;
        time += 0.016;

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is WebGL, not a React Hook
        gl.useProgram(program);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        gl.uniform1f(timeLocation, time);
        gl.uniform2f(mouseLocation, mouseRef.x, mouseRef.y);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        animationFrameId = requestAnimationFrame(render);
      };

      render();
    };

    // ── MAIN: WebGPU Particle simulation ──
    const initWebGPU = async () => {
      try {
        if (!navigator.gpu) {
          runWebGLFallback();
          return;
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          runWebGLFallback();
          return;
        }

        const device = await adapter.requestDevice();
        const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
        if (!context) {
          runWebGLFallback();
          return;
        }

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({
          device,
          format,
          alphaMode: "premultiplied",
        });

        // WGSL Shaders
        const shaderModule = device.createShaderModule({
          code: `
            struct Uniforms {
              time: f32,
              mouseX: f32,
              mouseY: f32,
              padding: f32,
            }

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            struct VertexOutput {
              @builtin(position) position: vec4f,
              @location(0) color: vec4f,
            }

            @vertex
            fn vs_main(
              @builtin(vertex_index) vertex_index: u32,
              @builtin(instance_index) instance_index: u32
            ) -> VertexOutput {
              let gridWidth = 96u;
              let x = f32(instance_index % gridWidth);
              let y = f32(instance_index / gridWidth);
              
              var px = (x / f32(gridWidth)) * 2.0 - 1.0;
              var py = (y / f32(gridWidth)) * 2.0 - 1.0;
              
              // Wave animation
              let dist = sqrt(px * px + py * py);
              let wave = sin(dist * 12.0 - uniforms.time * 2.0) * 0.06;
              px += cos(uniforms.time + py * 4.0) * 0.01;
              py += wave;
              
              // Mouse interactivity
              let dx = px - uniforms.mouseX;
              let dy = py - uniforms.mouseY;
              let mouseDist = sqrt(dx * dx + dy * dy);
              if (mouseDist < 0.25) {
                let force = (0.25 - mouseDist) * 0.08;
                px += (dx / max(mouseDist, 0.001)) * force;
                py += (dy / max(mouseDist, 0.001)) * force;
              }
              
              // Draw small square/dot (vertex coordinates)
              var offset = vec2f(0.0);
              let size = 0.0025;
              if (vertex_index == 0u) { offset = vec2f(-size, -size); }
              else if (vertex_index == 1u) { offset = vec2f(size, -size); }
              else if (vertex_index == 2u) { offset = vec2f(-size, size); }
              else if (vertex_index == 3u) { offset = vec2f(-size, size); }
              else if (vertex_index == 4u) { offset = vec2f(size, -size); }
              else if (vertex_index == 5u) { offset = vec2f(size, size); }
              
              var out: VertexOutput;
              out.position = vec4f(px + offset.x, py + offset.y, 0.0, 1.0);
              
              let alpha = 0.12 + (1.0 - dist) * 0.28;
              out.color = vec4f(1.0, 0.35, 0.0, alpha); // Premium Eliza Orange Glow
              return out;
            }

            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4f {
              return in.color;
            }
          `,
        });

        // Pipeline
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: {
            module: shaderModule,
            entryPoint: "vs_main",
          },
          fragment: {
            module: shaderModule,
            entryPoint: "fs_main",
            targets: [
              {
                format,
                blend: {
                  color: {
                    srcFactor: "src-alpha",
                    dstFactor: "one",
                    operation: "add",
                  },
                  alpha: {
                    srcFactor: "one",
                    dstFactor: "one",
                    operation: "add",
                  },
                },
              },
            ],
          },
          primitive: {
            topology: "triangle-list",
          },
        });

        // Uniform Buffers (5 floats padded to 16 bytes alignment block)
        // [time, mouseX, mouseY, padding] -> 4 floats = 16 bytes
        const GPUBufferUsageLocal = (window as any).GPUBufferUsage || {
          UNIFORM: 64,
          COPY_DST: 8,
        };
        const uniformBuffer = device.createBuffer({
          size: 16,
          usage: GPUBufferUsageLocal.UNIFORM | GPUBufferUsageLocal.COPY_DST,
        });

        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: uniformBuffer,
              },
            },
          ],
        });

        const numInstances = 96 * 96; // 9216 particles

        const render = () => {
          if (!active) return;
          time += 0.016;

          // Write uniforms
          const uniformsArray = new Float32Array([
            time,
            mouseRef.x,
            mouseRef.y,
            0,
          ]);
          device.queue.writeBuffer(uniformBuffer, 0, uniformsArray);

          const commandEncoder = device.createCommandEncoder();
          const textureView = context.getCurrentTexture().createView();

          const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [
              {
                view: textureView,
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
                loadOp: "clear",
                storeOp: "store",
              },
            ],
          };

          const passEncoder =
            commandEncoder.beginRenderPass(renderPassDescriptor);
          passEncoder.setPipeline(pipeline);
          passEncoder.setBindGroup(0, bindGroup);
          passEncoder.draw(6, numInstances);
          passEncoder.end();

          device.queue.submit([commandEncoder.finish()]);

          animationFrameId = requestAnimationFrame(render);
        };

        render();
      } catch (err) {
        console.warn("WebGPU initialization failed, using WebGL fallback", err);
        runWebGLFallback();
      }
    };

    initWebGPU();

    return () => {
      active = false;
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ mixBlendMode: "screen", zIndex: 0 }}
    />
  );
}
