import type {
  ElizaOsImage,
  InstallerStep,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";

const gib = 1024 ** 3;
const sha256Pattern = /^[a-f0-9]{64}$/;
const validChannels = new Set<ElizaOsImage["channel"]>([
  "stable",
  "beta",
  "nightly",
]);
const validArchitectures = new Set<ElizaOsImage["architecture"]>([
  "x86_64",
  "arm64",
]);

interface ImageManifestValidationIssue {
  imageId: string;
  field: keyof ElizaOsImage;
  message: string;
}

export const DEFAULT_ELIZAOS_IMAGES: ElizaOsImage[] = [
  {
    id: "elizaos-linux-live-stable",
    label: "elizaOS Linux Live",
    version: "stable",
    channel: "stable",
    architecture: "x86_64",
    buildId: "linux-live-stable-2026.05",
    publishedAt: "2026-05-15T00:00:00.000Z",
    url: "https://download.elizaos.ai/os/linux/elizaos-linux-live-stable.iso",
    checksumSha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    sizeBytes: 4.8 * gib,
    minUsbSizeBytes: 8 * gib,
    manifestVersion: 1,
    releaseNotesUrl: "https://docs.eliza.ai/os/linux",
    signatureUrl:
      "https://download.elizaos.ai/os/linux/elizaos-linux-live-stable.iso.sig",
  },
  {
    id: "elizaos-linux-live-nightly",
    label: "elizaOS Linux Live",
    version: "nightly",
    channel: "nightly",
    architecture: "x86_64",
    buildId: "linux-live-nightly-2026.05.15",
    publishedAt: "2026-05-15T00:00:00.000Z",
    url: "https://download.elizaos.ai/os/linux/elizaos-linux-live-nightly.iso",
    checksumSha256:
      "1111111111111111111111111111111111111111111111111111111111111111",
    sizeBytes: 4.9 * gib,
    minUsbSizeBytes: 8 * gib,
    manifestVersion: 1,
    releaseNotesUrl: "https://docs.eliza.ai/os/linux",
    signatureUrl:
      "https://download.elizaos.ai/os/linux/elizaos-linux-live-nightly.iso.sig",
  },
];

export const MOCK_REMOVABLE_DRIVES: RemovableDrive[] = [
  {
    id: "mock-usb-32gb",
    name: "USB Installer Media",
    devicePath: "/dev/disk4",
    sizeBytes: 29.8 * gib,
    bus: "usb",
    platform: "darwin",
    safety: "safe-removable",
    description: "Mock removable drive exposed by the dry-run backend.",
  },
  {
    id: "mock-internal-system",
    name: "Macintosh HD",
    devicePath: "/dev/disk3",
    sizeBytes: 512 * gib,
    bus: "unknown",
    platform: "darwin",
    safety: "blocked-system",
    description: "Blocked example to exercise destructive-write safeguards.",
  },
];

const STEP_LABELS: Record<InstallerStep["id"], string> = {
  "resolve-image": "Resolve image",
  checksum: "Validate checksum",
  write: "Write image",
  verify: "Verify media",
  complete: "Complete",
};

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function addIssue(
  issues: ImageManifestValidationIssue[],
  image: ElizaOsImage,
  field: keyof ElizaOsImage,
  message: string,
) {
  issues.push({
    imageId: image.id || "<missing-id>",
    field,
    message,
  });
}

export function validateImageManifest(
  images: ElizaOsImage[],
): ImageManifestValidationIssue[] {
  const issues: ImageManifestValidationIssue[] = [];

  for (const image of images) {
    if (!image.id) {
      addIssue(issues, image, "id", "Image id is required.");
    }
    if (!image.label) {
      addIssue(issues, image, "label", "Image label is required.");
    }
    if (!image.version) {
      addIssue(issues, image, "version", "Image version is required.");
    }
    if (!validChannels.has(image.channel)) {
      addIssue(issues, image, "channel", "Image channel is not supported.");
    }
    if (!validArchitectures.has(image.architecture)) {
      addIssue(
        issues,
        image,
        "architecture",
        "Image architecture is not supported.",
      );
    }
    if (!image.buildId) {
      addIssue(issues, image, "buildId", "Image build id is required.");
    }
    if (!isIsoDate(image.publishedAt)) {
      addIssue(issues, image, "publishedAt", "Published date is invalid.");
    }
    if (!isHttpsUrl(image.url)) {
      addIssue(issues, image, "url", "Image URL must be HTTPS.");
    }
    if (!sha256Pattern.test(image.checksumSha256)) {
      addIssue(
        issues,
        image,
        "checksumSha256",
        "Image checksum must be a 64-character lowercase SHA-256 hash.",
      );
    }
    if (!(image.sizeBytes > 0)) {
      addIssue(issues, image, "sizeBytes", "Image size must be positive.");
    }
    if (!(image.minUsbSizeBytes > 0)) {
      addIssue(
        issues,
        image,
        "minUsbSizeBytes",
        "Minimum USB size must be positive.",
      );
    }
    if (image.minUsbSizeBytes < image.sizeBytes) {
      addIssue(
        issues,
        image,
        "minUsbSizeBytes",
        "Minimum USB size cannot be smaller than the image size.",
      );
    }
    if (image.manifestVersion !== 1) {
      addIssue(
        issues,
        image,
        "manifestVersion",
        "Only image manifest version 1 is supported.",
      );
    }
    if (image.releaseNotesUrl && !isHttpsUrl(image.releaseNotesUrl)) {
      addIssue(
        issues,
        image,
        "releaseNotesUrl",
        "Release notes URL must be HTTPS.",
      );
    }
    if (image.signatureUrl && !isHttpsUrl(image.signatureUrl)) {
      addIssue(issues, image, "signatureUrl", "Signature URL must be HTTPS.");
    }
  }

  return issues;
}

function assertValidImageManifest(images: ElizaOsImage[]): void {
  const issues = validateImageManifest(images);
  if (issues.length > 0) {
    const summary = issues
      .map(
        (issue) => `${issue.imageId}.${String(issue.field)}: ${issue.message}`,
      )
      .join(" ");
    throw new Error(`Invalid elizaOS image manifest: ${summary}`);
  }
}

function createDryRunSteps(blockedReason: string | null): InstallerStep[] {
  return (Object.keys(STEP_LABELS) as InstallerStep["id"][]).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: blockedReason ? "blocked" : "complete",
    detail: blockedReason
      ? `Blocked before write: ${blockedReason}`
      : "Dry-run complete; no bytes were written.",
  }));
}

export class DryRunUsbInstallerBackend implements UsbInstallerBackend {
  constructor(
    private readonly drives: RemovableDrive[] = MOCK_REMOVABLE_DRIVES,
    private readonly images: ElizaOsImage[] = DEFAULT_ELIZAOS_IMAGES,
  ) {
    assertValidImageManifest(images);
  }

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    return this.drives;
  }

  async listImages(): Promise<ElizaOsImage[]> {
    assertValidImageManifest(this.images);
    return this.images;
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    if (!request.dryRun) {
      throw new Error(
        "Non-dry-run writes are blocked: raw USB writes are not implemented in this package.",
      );
    }

    const drive = this.drives.find(
      (candidate) => candidate.id === request.driveId,
    );
    if (!drive) {
      throw new Error(`Unknown drive id: ${request.driveId}`);
    }

    const image = this.images.find(
      (candidate) => candidate.id === request.imageId,
    );
    if (!image) {
      throw new Error(`Unknown image id: ${request.imageId}`);
    }

    if (!request.acknowledgeDataLoss) {
      throw new Error(
        "Data-loss acknowledgement is required before preparing media.",
      );
    }

    const blockedReason =
      drive.safety !== "safe-removable"
        ? "the target is not marked safe-removable."
        : drive.sizeBytes < image.minUsbSizeBytes
          ? `the target is ${Math.round(
              drive.sizeBytes / gib,
            )} GiB but ${Math.round(image.minUsbSizeBytes / gib)} GiB is required.`
          : null;

    return {
      request: { ...request, dryRun: true },
      drive,
      image,
      steps: createDryRunSteps(blockedReason),
      privilegedWriteImplemented: false,
    };
  }
}
