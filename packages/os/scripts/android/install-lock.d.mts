export function syncDirectory(directory: string): void;
export function syncDirectoryTree(directory: string): void;
export function withDeviceInstallLock<T>(
  serial: string,
  metadata: Record<string, unknown>,
  action: (context: { beforeWrites(): void }) => T,
  directory?: string,
): T;
