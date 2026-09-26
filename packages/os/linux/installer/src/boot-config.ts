export interface FactoryBootLayout {
  readonly architecture: "x86_64" | "arm64";
  readonly kernelArguments: readonly string[];
  readonly kernelPath: string;
  readonly initrdPaths: readonly string[];
  readonly recoveryKernelPath: string;
  readonly recoveryInitrdPaths: readonly string[];
}

export interface InstalledBootConfiguration extends FactoryBootLayout {
  rootUuid: string;
  recoveryUuid: string;
}

export class InstallBootConfigurationError extends Error {
  readonly code = "ELIZAOS_INSTALL_BOOT_CONFIGURATION_ERROR";
}

/** Validate the literal boot layout shared by signed factory metadata and the
 * installed GRUB renderer. Root selectors are provided separately at install. */
export function assertFactoryBootLayout(
  config: unknown,
): asserts config is FactoryBootLayout {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new InstallBootConfigurationError(
      "Factory boot layout must be an object.",
    );
  }
  const value = config as Record<string, unknown>;
  if (
    typeof value.architecture !== "string" ||
    !["x86_64", "arm64"].includes(value.architecture) ||
    !Array.isArray(value.kernelArguments) ||
    value.kernelArguments.some(
      (argument) =>
        typeof argument !== "string" ||
        !/^[a-zA-Z0-9_.:/,=+-]+$/.test(argument) ||
        /^(?:root|init|rdinit|(?:rd\.)?systemd\.(?:unit|machine_id|condition_first_boot|volatile)|elizaos\.recovery)=/.test(
          argument.replaceAll("-", "_"),
        ) ||
        /^(?:ro|rw)$/.test(argument),
    )
  ) {
    throw new InstallBootConfigurationError(
      "Boot configuration requires supported EFI architecture and literal non-root kernel arguments.",
    );
  }
  bootPath(value.kernelPath);
  bootPath(value.recoveryKernelPath);
  for (const paths of [value.initrdPaths, value.recoveryInitrdPaths]) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new InstallBootConfigurationError(
        "Boot entries require their complete initrd sequence.",
      );
    }
    for (const path of paths) bootPath(path);
  }
}

function bootPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^\/(?:[a-zA-Z0-9_+.-]+\/)*[a-zA-Z0-9_+.-]+$/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new InstallBootConfigurationError(
      "Boot payload path is not a literal absolute FAT path.",
    );
  }
  return `($root)${value}`;
}

export function renderInstalledGrubConfiguration(
  config: InstalledBootConfiguration,
): string {
  assertFactoryBootLayout(config);
  const argumentsText = config.kernelArguments.length
    ? ` ${config.kernelArguments.join(" ")}`
    : "";
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (
    !uuid.test(config.rootUuid) ||
    !uuid.test(config.recoveryUuid) ||
    config.rootUuid === config.recoveryUuid ||
    [config.rootUuid, config.recoveryUuid].includes(
      "00000000-0000-0000-0000-000000000000",
    )
  ) {
    throw new InstallBootConfigurationError(
      "Installed root and recovery require distinct nonzero filesystem UUIDs.",
    );
  }
  const initrds = (paths: readonly string[]) => paths.map(bootPath).join(" ");
  return `set default=0
set timeout=5
menuentry 'elizaOS' --id elizaos {
    linux ${bootPath(config.kernelPath)} root=UUID=${config.rootUuid} rw${argumentsText}
    initrd ${initrds(config.initrdPaths)}
}
menuentry 'elizaOS Recovery' --id elizaos-recovery --hotkey=r {
    linux ${bootPath(config.recoveryKernelPath)} root=UUID=${config.recoveryUuid} ro systemd.volatile=state systemd.unit=rescue.target elizaos.recovery=1${argumentsText}
    initrd ${initrds(config.recoveryInitrdPaths)}
}
`;
}

/** Complete files consumed by the supported Debian EFI boot chain. */
export function factoryBootPayloadPaths(layout: FactoryBootLayout): string[] {
  assertFactoryBootLayout(layout);
  const suffix = layout.architecture === "x86_64" ? "x64" : "aa64";
  return [
    ...new Set([
      `/EFI/BOOT/BOOT${suffix}.EFI`,
      `/EFI/BOOT/GRUB${suffix}.EFI`,
      "/EFI/debian/grub.cfg",
      "/grub/grub.cfg",
      layout.kernelPath,
      ...layout.initrdPaths,
      layout.recoveryKernelPath,
      ...layout.recoveryInitrdPaths,
    ]),
  ];
}
