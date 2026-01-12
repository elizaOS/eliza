import { exec } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

const execAsync = promisify(exec);

export interface SystemGPU {
  name: string;
  memory?: number;
  type: "cuda" | "metal" | "directml" | "none";
  version?: string;
  isAppleSilicon?: boolean;
}

export interface SystemCPU {
  model: string;
  cores: number;
  speed: number;
  architecture: string;
  memory: {
    total: number;
    free: number;
  };
}

export interface SystemCapabilities {
  platform: NodeJS.Platform;
  cpu: SystemCPU;
  gpu: SystemGPU | null;
  recommendedModelSize: "small" | "medium" | "large";
  supportedBackends: Array<"cuda" | "metal" | "directml" | "cpu">;
}

export class PlatformManager {
  private static instance: PlatformManager;
  private capabilities: SystemCapabilities | null = null;

  private constructor() {}

  static getInstance(): PlatformManager {
    if (!PlatformManager.instance) {
      PlatformManager.instance = new PlatformManager();
    }
    return PlatformManager.instance;
  }

  async initialize(): Promise<void> {
    try {
      logger.info("Initializing platform detection...");
      this.capabilities = await this.detectSystemCapabilities();
    } catch (error) {
      logger.error("Platform detection failed", { error });
      throw error;
    }
  }

  private async detectSystemCapabilities(): Promise<SystemCapabilities> {
    const platform = process.platform;
    const cpuInfo = this.getCPUInfo();
    const gpu = await this.detectGPU();
    const supportedBackends = await this.getSupportedBackends(platform, gpu);
    const recommendedModelSize = this.getRecommendedModelSize(cpuInfo, gpu);

    return {
      platform,
      cpu: cpuInfo,
      gpu,
      recommendedModelSize,
      supportedBackends,
    };
  }

  private getCPUInfo(): SystemCPU {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();

    return {
      model: cpus[0].model,
      cores: cpus.length,
      speed: cpus[0].speed,
      architecture: process.arch,
      memory: {
        total: totalMemory,
        free: freeMemory,
      },
    };
  }

  private async detectGPU(): Promise<SystemGPU | null> {
    const platform = process.platform;

    try {
      switch (platform) {
        case "darwin":
          return await this.detectMacGPU();
        case "win32":
          return await this.detectWindowsGPU();
        case "linux":
          return await this.detectLinuxGPU();
        default:
          return null;
      }
    } catch (error) {
      logger.error("GPU detection failed", { error });
      return null;
    }
  }

  private async detectMacGPU(): Promise<SystemGPU> {
    try {
      const { stdout } = await execAsync("sysctl -n machdep.cpu.brand_string");
      const isAppleSilicon = stdout.toLowerCase().includes("apple");

      if (isAppleSilicon) {
        return {
          name: "Apple Silicon",
          type: "metal",
          isAppleSilicon: true,
        };
      }

      const { stdout: gpuInfo } = await execAsync("system_profiler SPDisplaysDataType");
      return {
        name: gpuInfo.split("Chipset Model:")[1]?.split("\n")[0]?.trim() || "Unknown GPU",
        type: "metal",
        isAppleSilicon: false,
      };
    } catch (error) {
      logger.error("Mac GPU detection failed", { error });
      return {
        name: "Unknown Mac GPU",
        type: "metal",
        isAppleSilicon: false,
      };
    }
  }

  private async detectWindowsGPU(): Promise<SystemGPU | null> {
    try {
      const { stdout } = await execAsync("wmic path win32_VideoController get name");
      const gpuName = stdout.split("\n")[1].trim();

      if (gpuName.toLowerCase().includes("nvidia")) {
        const { stdout: nvidiaInfo } = await execAsync(
          "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"
        );
        const [name, memoryStr] = nvidiaInfo.split(",").map((s) => s.trim());
        const memory = Number.parseInt(memoryStr, 10);

        return {
          name,
          memory,
          type: "cuda",
          version: await this.getNvidiaDriverVersion(),
        };
      }

      return {
        name: gpuName,
        type: "directml",
      };
    } catch (error) {
      logger.error("Windows GPU detection failed", { error });
      return null;
    }
  }

  private async detectLinuxGPU(): Promise<SystemGPU | null> {
    try {
      const { stdout } = await execAsync(
        "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"
      );
      if (stdout) {
        const [name, memoryStr] = stdout.split(",").map((s) => s.trim());
        const memory = Number.parseInt(memoryStr, 10);

        return {
          name,
          memory,
          type: "cuda",
          version: await this.getNvidiaDriverVersion(),
        };
      }
    } catch {
      try {
        const { stdout } = await execAsync("lspci | grep -i vga");
        return {
          name: stdout.split(":").pop()?.trim() || "Unknown GPU",
          type: "none",
        };
      } catch (error) {
        logger.error("Linux GPU detection failed", { error });
        return null;
      }
    }
    return null;
  }

  private async getNvidiaDriverVersion(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        "nvidia-smi --query-gpu=driver_version --format=csv,noheader"
      );
      return stdout.trim();
    } catch {
      return "unknown";
    }
  }

  private async getSupportedBackends(
    platform: NodeJS.Platform,
    gpu: SystemGPU | null
  ): Promise<Array<"cuda" | "metal" | "directml" | "cpu">> {
    const backends: Array<"cuda" | "metal" | "directml" | "cpu"> = ["cpu"];

    if (gpu) {
      switch (platform) {
        case "darwin":
          backends.push("metal");
          break;
        case "win32":
          if (gpu.type === "cuda") {
            backends.push("cuda");
          }
          backends.push("directml");
          break;
        case "linux":
          if (gpu.type === "cuda") {
            backends.push("cuda");
          }
          break;
      }
    }

    return backends;
  }

  private getRecommendedModelSize(
    cpu: SystemCPU,
    gpu: SystemGPU | null
  ): "small" | "medium" | "large" {
    if (gpu?.isAppleSilicon) {
      return cpu.memory.total > 16 * 1024 * 1024 * 1024 ? "medium" : "small";
    }

    if (gpu?.type === "cuda") {
      const gpuMemGB = (gpu.memory || 0) / 1024;
      if (gpuMemGB >= 16) return "large";
      if (gpuMemGB >= 8) return "medium";
    }

    if (cpu.memory.total > 32 * 1024 * 1024 * 1024) return "medium";

    return "small";
  }

  getCapabilities(): SystemCapabilities {
    if (!this.capabilities) {
      throw new Error("PlatformManager not initialized");
    }
    return this.capabilities;
  }

  isAppleSilicon(): boolean {
    return !!this.capabilities?.gpu?.isAppleSilicon;
  }

  hasGPUSupport(): boolean {
    return !!this.capabilities?.gpu;
  }

  supportsCUDA(): boolean {
    return this.capabilities?.gpu?.type === "cuda";
  }

  supportsMetal(): boolean {
    return this.capabilities?.gpu?.type === "metal";
  }

  supportsDirectML(): boolean {
    return this.capabilities?.gpu?.type === "directml";
  }

  getRecommendedBackend(): "cuda" | "metal" | "directml" | "cpu" {
    if (!this.capabilities) {
      throw new Error("PlatformManager not initialized");
    }

    const { gpu, supportedBackends } = this.capabilities;

    if (gpu?.type === "cuda") return "cuda";
    if (gpu?.type === "metal") return "metal";
    if (supportedBackends.includes("directml")) return "directml";
    return "cpu";
  }
}

export const getPlatformManager = (): PlatformManager => {
  return PlatformManager.getInstance();
};
