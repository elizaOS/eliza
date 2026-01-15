declare module '@tauri-apps/api/core' {
  /**
   * Invoke a Tauri command
   */
  export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}
