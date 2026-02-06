import pLimit from "p-limit";
import { itemTemplates } from "../gameComponents";

const imageCache = {};

export const getImageWithRetry = async (url, retry = 0) => {
  if (!url) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      if (retry < 2) {
        getImageWithRetry(url, retry + 1)
          .then(resolve)
          .catch(reject);
      } else {
        reject(new Error(`Failed to load: <${url}>`));
      }
    };
    img.src = url;
  });
};

export const getImage = (url, defaultImage = "/default.png") => {
  if (!url) {
    return null;
  }
  if (!imageCache[url]) {
    imageCache[url] = new Promise((resolve) => {
      getImageWithRetry(url)
        .then(resolve)
        .catch(async () => {
          console.log(`Missing image <${url}>`);
          resolve(await getImage(defaultImage));
        });
    });
  }
  return imageCache[url];
};

export class ItemMediaUploader {
  constructor(onFile) {
    this.onFile = onFile;
    this.queue = pLimit(4);
    this.cache = {};
  }

  async uploadMedia(media) {
    if (typeof media === "object" && media?.file) {
      if (!this.cache[media.file]) {
        this.cache[media.file] = this.queue(this.onFile, media.file);
      }
      return {
        type: "local",
        content: await this.cache[media.file],
      };
    } else {
      return media;
    }
  }

  async upload(item) {
    const template = itemTemplates[item.type];
    if (!template) {
      return item;
    }
    const itemCloned = JSON.parse(JSON.stringify(item));

    await template.mapMedia(itemCloned, async (media) => {
      return this.uploadMedia(media);
    });

    return itemCloned;
  }
}

export const imageAsBlob = async (image) => {
  const response = await fetch(image.src);
  return await response.blob();
};

export const URLAsBlob = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }
  return await response.blob();
};

export async function hashBlob(blob) {
  // Read the blob as an ArrayBuffer
  const blobBuffer = await readBlobAsArrayBuffer(blob);

  // Use the SubtleCrypto API to hash the content
  const hashBuffer = await crypto.subtle.digest("SHA-256", blobBuffer);

  // Convert the hash to a hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
}

function readBlobAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.readAsArrayBuffer(blob);
  });
}
