export interface InstalledSystemMounts {
  homeUuid: string;
  espUuid: string;
}

export interface InstalledRootConfiguration extends InstalledSystemMounts {
  /** Allocate once in the trusted install session, before preparing the ESP. */
  rootUuid: string;
}

export class InstallSystemConfigurationError extends Error {
  readonly code = "ELIZAOS_INSTALL_SYSTEM_CONFIGURATION_ERROR";
}

/** Canonical mkosi mountpoints; never reuse factory media labels or paths. */
export function renderInstalledFstab(
  rootUuid: string,
  mounts: InstalledSystemMounts,
): string {
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (
    !uuid.test(rootUuid) ||
    !uuid.test(mounts.homeUuid) ||
    rootUuid === mounts.homeUuid ||
    [rootUuid, mounts.homeUuid].includes(
      "00000000-0000-0000-0000-000000000000",
    ) ||
    !/^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/.test(mounts.espUuid) ||
    mounts.espUuid === "0000-0000"
  )
    throw new InstallSystemConfigurationError(
      "Installed mounts require distinct nonzero ext4 UUIDs and a nonzero FAT volume ID.",
    );
  return `# Installed elizaOS filesystems\nUUID=${rootUuid} / ext4 defaults,errors=remount-ro 0 1\nUUID=${mounts.homeUuid} /home ext4 defaults 0 2\nUUID=${mounts.espUuid.toUpperCase()} /efi vfat umask=0077 0 2\n`;
}

/** Only an unused factory mount table can be replaced without a migration. */
export function assertUnusedFactoryFstab(content: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    throw new InstallSystemConfigurationError(
      "Factory fstab is not valid UTF-8.",
      { cause },
    );
  }
  if (
    text.includes("\0") ||
    text
      .split(/\r?\n/)
      .some((line) => line.trim() && !line.trimStart().startsWith("#"))
  ) {
    throw new InstallSystemConfigurationError(
      "Factory fstab contains existing mount configuration; explicit migration is required.",
    );
  }
}
