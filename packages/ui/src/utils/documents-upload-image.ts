export type DocumentImageUploadFile = File & {
  webkitRelativePath?: string;
};

export type DocumentImageCompressionPlatform = {
  isAvailable: () => boolean;
  loadImageSource: (file: File) => Promise<{
    source: CanvasImageSource;
    width: number;
    height: number;
  }>;
  renderBlob: (input: {
    source: CanvasImageSource;
    width: number;
    height: number;
    outputType: string;
    quality: number;
  }) => Promise<Blob>;
};

export const MAX_DOCUMENT_IMAGE_PROCESSING_BYTES = 5 * 1_048_576;

const TARGET_DOCUMENT_IMAGE_BYTES = Math.floor(
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES * 0.9,
);
const IMAGE_OUTPUT_TYPE = "image/jpeg";
const IMAGE_MAX_DIMENSION = 2560;
const IMAGE_MIN_DIMENSION = 320;
const IMAGE_SCALE_STEP = 0.82;
const IMAGE_QUALITY_STEPS = [0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

function browserCompressionPlatform(): DocumentImageCompressionPlatform {
  return {
    isAvailable: () =>
      typeof document !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function" &&
      typeof Image !== "undefined",
    loadImageSource: async (file) => {
      const objectUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const nextImage = new Image();
          nextImage.onload = () => resolve(nextImage);
          nextImage.onerror = () =>
            reject(new Error(`Failed to load image "${file.name}"`));
          nextImage.src = objectUrl;
        });
        return {
          source: image,
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        };
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    },
    renderBlob: async ({ source, width, height, outputType, quality }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");

      if (outputType === IMAGE_OUTPUT_TYPE) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(source, 0, 0, width, height);

      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Failed to encode optimized image"));
              return;
            }
            resolve(blob);
          },
          outputType,
          quality,
        );
      });
    },
  };
}

function clampDimensions(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const largestEdge = Math.max(width, height);
  if (largestEdge <= maxDimension) {
    return { width, height };
  }

  const scale = maxDimension / largestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function cloneUploadFile(
  file: DocumentImageUploadFile,
  blob: Blob,
): DocumentImageUploadFile {
  const cloned = new File([blob], file.name, {
    type: blob.type || file.type,
    lastModified: file.lastModified,
  }) as DocumentImageUploadFile;

  if (typeof file.webkitRelativePath === "string") {
    Object.defineProperty(cloned, "webkitRelativePath", {
      value: file.webkitRelativePath,
      configurable: true,
    });
  }

  return cloned;
}

export function isDocumentImageFile(
  file: Pick<File, "name" | "type">,
): boolean {
  if (file.type.startsWith("image/")) return true;
  const lowerName = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

export async function maybeCompressDocumentUploadImage(
  file: DocumentImageUploadFile,
  platform: DocumentImageCompressionPlatform = browserCompressionPlatform(),
): Promise<{
  file: DocumentImageUploadFile;
  optimized: boolean;
  originalSize: number;
  optimizedSize: number;
}> {
  if (
    !isDocumentImageFile(file) ||
    file.size <= MAX_DOCUMENT_IMAGE_PROCESSING_BYTES ||
    !platform.isAvailable()
  ) {
    return {
      file,
      optimized: false,
      originalSize: file.size,
      optimizedSize: file.size,
    };
  }

  const image = await platform.loadImageSource(file);
  let { width, height } = clampDimensions(
    image.width,
    image.height,
    IMAGE_MAX_DIMENSION,
  );
  let bestBlob: Blob | null = null;

  while (true) {
    for (const quality of IMAGE_QUALITY_STEPS) {
      const blob = await platform.renderBlob({
        source: image.source,
        width,
        height,
        outputType: IMAGE_OUTPUT_TYPE,
        quality,
      });

      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }

      if (blob.size <= TARGET_DOCUMENT_IMAGE_BYTES) {
        return {
          file: cloneUploadFile(file, blob),
          optimized: true,
          originalSize: file.size,
          optimizedSize: blob.size,
        };
      }
    }

    const largestEdge = Math.max(width, height);
    if (largestEdge <= IMAGE_MIN_DIMENSION) break;

    const nextScale = Math.max(
      IMAGE_MIN_DIMENSION / largestEdge,
      IMAGE_SCALE_STEP,
    );
    if (nextScale >= 1) break;

    width = Math.max(1, Math.round(width * nextScale));
    height = Math.max(1, Math.round(height * nextScale));
  }

  if (bestBlob && bestBlob.size < file.size) {
    return {
      file: cloneUploadFile(file, bestBlob),
      optimized: true,
      originalSize: file.size,
      optimizedSize: bestBlob.size,
    };
  }

  return {
    file,
    optimized: false,
    originalSize: file.size,
    optimizedSize: file.size,
  };
}
