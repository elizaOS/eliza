import { exec } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { logger } from '@elizaos/core';

const execAsync = promisify(exec);

/**
 * Represents the configuration of a system GPU.
 * @typedef {Object} SystemGPU
 * @property {string} name - The name of the GPU.
 * @property {number} [memory] - The memory size of the GPU. (Optional)
 * @property {"cuda" | "metal" | "directml" | "none"} type - The type of GPU.
 * @property {string} [version] - The version of the GPU. (Optional)
 * @property {boolean} [isAppleSilicon] - Indicates if the GPU is Apple Silicon. (Optional)
 */
export interface SystemGPU {
  name: string;
  memory?: number;
  type: 'cuda' | 'metal' | 'directml' | 'none';
  version?: string;
  isAppleSilicon?: boolean;
}

/**
 * Interface representing the system CPU information.
 * @typedef {Object} SystemCPU
 * @property {string} model - The model of the CPU.
 * @property {number} cores - The number of cores in the CPU.
 * @property {number} speed - The speed of the CPU.
 * @property {string} architecture - The architecture of the CPU.
 * @property {Object} memory - Object containing memory information.
 * @property {number} memory.total - The total memory available.
 * @property {number} memory.free - The free memory available.
 */
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

/**
 * Interface representing the capabilities of a system.
 *
 * @typedef {Object} SystemCapabilities
 * @property {NodeJS.Platform} platform - The platform of the system.
 * @property {SystemCPU} cpu - The CPU information of the system.
 * @property {SystemGPU | null} gpu - The GPU information of the system, can be null if no GPU is present.
 * @property {"small" | "medium" | "large"} recommendedModelSize - The recommended model size for the system.
 * @property {Array<"cuda" | "metal" | "directml" | "cpu">} supportedBackends - An array of supported backends for the system.
 */
export interface SystemCapabilities {
  platform: NodeJS.Platform;
  cpu: SystemCPU;
  gpu: SystemGPU | null;
  recommendedModelSize: 'small' | 'medium' | 'large';
  supportedBackends: Array<'cuda' | 'metal' | 'directml' | 'cpu'>;
}

/**
 * Class representing a Platform Manager.
 *
 * @class
 */

export class PlatformManager {
  private static instance: PlatformManager;
  private capabilities: SystemCapabilities | null = null;

  /**
   * Private constructor method.
   */
  private constructor() {}

  /**
   * Get the singleton instance of the PlatformManager class
   * @returns {PlatformManager} The instance of PlatformManager
   */
  static getInstance(): PlatformManager {
    if (!PlatformManager.instance) {
      PlatformManager.instance = new PlatformManager();
    }
    return PlatformManager.instance;
  }

  /**
   * Asynchronous method to initialize platform detection.
   *
   * @returns {Promise<void>} Promise that resolves once platform detection is completed.
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing platform detection...');
      this.capabilities = await this.detectSystemCapabilities();
      // logger.info("Platform detection completed", {
      //   platform: this.capabilities.platform,
      //   gpu: this.capabilities.gpu?.type || "none",
      //   recommendedModel: this.capabilities.recommendedModelSize,
      // });
    } catch (error) {
      logger.error('Platform detection failed', { error });
      throw error;
    }
  }

  /**
   * Detects the system capabilities including platform, CPU information, GPU information,
   * supported backends, and recommended model size.
   *
   * @returns {Promise<SystemCapabilities>} Details of the system capabilities including platform, CPU info, GPU info,
   * recommended model size, and supported backends.
   */
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

  /**
   * Returns information about the CPU and memory of the system.
   * @returns {SystemCPU} The CPU information including model, number of cores, speed, architecture, and memory details.
   */
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

  /**
   * Asynchronously detects the GPU information based on the current platform.
   * @returns A promise that resolves with the GPU information if detection is successful, otherwise null.
   */
  private async detectGPU(): Promise<SystemGPU | null> {
    const platform = process.platform;

    try {
      switch (platform) {
        case 'darwin':
          return await this.detectMacGPU();
        case 'win32':
          return await this.detectWindowsGPU();
        case 'linux':
          return await this.detectLinuxGPU();
        default:
          return null;
      }
    } catch (error) {
      logger.error('GPU detection failed', { error });
      return null;
    }
  }

  /**
   * Asynchronously detects the GPU of a Mac system.
   * @returns {Promise<SystemGPU>} A promise that resolves to an object representing the detected GPU.
   */
  private async detectMacGPU(): Promise<SystemGPU> {
    try {
      const { stdout } = await execAsync('sysctl -n machdep.cpu.brand_string');
      const isAppleSilicon = stdout.toLowerCase().includes('apple');

      if (isAppleSilicon) {
        return {
          name: 'Apple Silicon',
          type: 'metal',
          isAppleSilicon: true,
        };
      }

      // For Intel Macs with discrete GPU
      const { stdout: gpuInfo } = await execAsync('system_profiler SPDisplaysDataType');
      return {
        name: gpuInfo.split('Chipset Model:')[1]?.split('\n')[0]?.trim() || 'Unknown GPU',
        type: 'metal',
        isAppleSilicon: false,
      };
    } catch (error) {
      logger.error('Mac GPU detection failed', { error });
      return {
        name: 'Unknown Mac GPU',
        type: 'metal',
        isAppleSilicon: false,
      };
    }
  }

  /**
   * Detects the GPU in a Windows system and returns information about it.
   *
   * @returns {Promise<SystemGPU | null>} A promise that resolves with the detected GPU information or null if detection fails.
   */
  private async detectWindowsGPU(): Promise<SystemGPU | null> {
    try {
      const { stdout } = await execAsync('wmic path win32_VideoController get name');
      const gpuName = stdout.split('\n')[1].trim();

      // Check for NVIDIA GPU
      if (gpuName.toLowerCase().includes('nvidia')) {
        const { stdout: nvidiaInfo } = await execAsync(
          'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'
        );
        const [name, memoryStr] = nvidiaInfo.split(',').map((s) => s.trim());
        const memory = Number.parseInt(memoryStr);

        return {
          name,
          memory,
          type: 'cuda',
          version: await this.getNvidiaDriverVersion(),
        };
      }

      // Default to DirectML for other GPUs
      return {
        name: gpuName,
        type: 'directml',
      };
    } catch (error) {
      logger.error('Windows GPU detection failed', { error });
      return null;
    }
  }

  /**
   * Asynchronously detects the GPU information for Linux systems.
   * Tries to detect NVIDIA GPU first using 'nvidia-smi' command and if successful,
   * returns the GPU name, memory size, type as 'cuda', and NVIDIA driver version.
   * If NVIDIA detection fails, it falls back to checking for other GPUs using 'lspci | grep -i vga' command.
   * If no GPU is detected, it returns null.
   *
   * @returns {Promise<SystemGPU | null>} The detected GPU information or null if detection fails.
   */
  private async detectLinuxGPU(): Promise<SystemGPU | null> {
    try {
      // Try NVIDIA first
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'
      );
      if (stdout) {
        const [name, memoryStr] = stdout.split(',').map((s) => s.trim());
        const memory = Number.parseInt(memoryStr);

        return {
          name,
          memory,
          type: 'cuda',
          version: await this.getNvidiaDriverVersion(),
        };
      }
    } catch {
      // If nvidia-smi fails, check for other GPUs
      try {
        const { stdout } = await execAsync('lspci | grep -i vga');
        return {
          name: stdout.split(':').pop()?.trim() || 'Unknown GPU',
          type: 'none',
        };
      } catch (error) {
        logger.error('Linux GPU detection failed', { error });
        return null;
      }
    }
    return null;
  }

  /**
   * Asynchronously retrieves the driver version of the Nvidia GPU using the 'nvidia-smi' command.
   *
   * @returns A promise that resolves with the driver version as a string, or 'unknown' if an error occurs.
   */
  private async getNvidiaDriverVersion(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=driver_version --format=csv,noheader'
      );
      return stdout.trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Retrieves the supported backends based on the platform and GPU type.
   * @param {NodeJS.Platform} platform - The platform on which the code is running.
   * @param {SystemGPU | null} gpu - The GPU information, if available.
   * @returns {Promise<Array<"cuda" | "metal" | "directml" | "cpu">>} - An array of supported backends including 'cuda', 'metal', 'directml', and 'cpu'.
   */
  private async getSupportedBackends(
    platform: NodeJS.Platform,
    gpu: SystemGPU | null
  ): Promise<Array<'cuda' | 'metal' | 'directml' | 'cpu'>> {
    const backends: Array<'cuda' | 'metal' | 'directml' | 'cpu'> = ['cpu'];

    if (gpu) {
      switch (platform) {
        case 'darwin':
          backends.push('metal');
          break;
        case 'win32':
          if (gpu.type === 'cuda') {
            backends.push('cuda');
          }
          backends.push('directml');
          break;
        case 'linux':
          if (gpu.type === 'cuda') {
            backends.push('cuda');
          }
          break;
      }
    }

    return backends;
  }

  /**
   * Determines the recommended model size based on the system's CPU and GPU.
   * @param {SystemCPU} cpu - The system's CPU.
   * @param {SystemGPU | null} gpu - The system's GPU, if available.
   * @returns {"small" | "medium" | "large"} - The recommended model size ("small", "medium", or "large").
   */
  private getRecommendedModelSize(
    cpu: SystemCPU,
    gpu: SystemGPU | null
  ): 'small' | 'medium' | 'large' {
    // For Apple Silicon
    if (gpu?.isAppleSilicon) {
      return cpu.memory.total > 16 * 1024 * 1024 * 1024 ? 'medium' : 'small';
    }

    // For NVIDIA GPUs
    if (gpu?.type === 'cuda') {
      const gpuMemGB = (gpu.memory || 0) / 1024;
      if (gpuMemGB >= 16) return 'large';
      if (gpuMemGB >= 8) return 'medium';
    }

    // For systems with significant RAM but no powerful GPU
    if (cpu.memory.total > 32 * 1024 * 1024 * 1024) return 'medium';

    // Default to small model
    return 'small';
  }

  /**
   * Returns the SystemCapabilities of the PlatformManager.
   *
   * @returns {SystemCapabilities} The SystemCapabilities of the PlatformManager.
   * @throws {Error} if PlatformManager is not initialized.
   */
  getCapabilities(): SystemCapabilities {
    if (!this.capabilities) {
      throw new Error('PlatformManager not initialized');
    }
    return this.capabilities;
  }

  /**
   * Checks if the device's GPU is Apple Silicon.
   * @returns {boolean} True if the GPU is Apple Silicon, false otherwise.
   */
  isAppleSilicon(): boolean {
    return !!this.capabilities?.gpu?.isAppleSilicon;
  }

  /**
   * Checks if the current device has GPU support.
   * @returns {boolean} - Returns true if the device has GPU support, false otherwise.
   */
  hasGPUSupport(): boolean {
    return !!this.capabilities?.gpu;
  }

  /**
   * Checks if the system supports CUDA GPU for processing.
   *
   * @returns {boolean} True if the system supports CUDA, false otherwise.
   */
  supportsCUDA(): boolean {
    return this.capabilities?.gpu?.type === 'cuda';
  }

  /**
   * Check if the device supports Metal API for rendering graphics.
   * @returns {boolean} True if the device supports Metal, false otherwise.
   */
  supportsMetal(): boolean {
    return this.capabilities?.gpu?.type === 'metal';
  }

  /**
   * Check if the device supports DirectML for GPU acceleration.
   *
   * @returns {boolean} True if the device supports DirectML, false otherwise.
   */
  supportsDirectML(): boolean {
    return this.capabilities?.gpu?.type === 'directml';
  }

  /**
   * Get the recommended backend for computation based on the available capabilities.
   * @returns {"cuda" | "metal" | "directml" | "cpu"} The recommended backend for computation.
   * @throws {Error} Throws an error if PlatformManager is not initialized.
   */
  getRecommendedBackend(): 'cuda' | 'metal' | 'directml' | 'cpu' {
    if (!this.capabilities) {
      throw new Error('PlatformManager not initialized');
    }

    const { gpu, supportedBackends } = this.capabilities;

    if (gpu?.type === 'cuda') return 'cuda';
    if (gpu?.type === 'metal') return 'metal';
    if (supportedBackends.includes('directml')) return 'directml';
    return 'cpu';
  }
}

// Export a helper function to get the singleton instance
export const getPlatformManager = (): PlatformManager => {
  return PlatformManager.getInstance();
};
