import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const publicDir = path.join(appDir, "public");
const electrobunAssetsDir = path.join(appDir, "electrobun", "assets");
const faviconSvgPath = path.join(publicDir, "favicon.svg");
const splashSvgPath = path.join(publicDir, "splash-bg.svg");
const splashJpgPath = path.join(publicDir, "splash-bg.jpg");
const appIconPngPath = path.join(electrobunAssetsDir, "appIcon.png");
const appIconIcoPath = path.join(electrobunAssetsDir, "appIcon.ico");
const appIconsetDir = path.join(electrobunAssetsDir, "appIcon.iconset");

const ICONSET_SIZES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function ensureMacTool(tool) {
  if (process.platform !== "darwin") {
    throw new Error(`${tool} asset generation currently requires macOS.`);
  }
  execFileSync("which", [tool], { stdio: "ignore" });
}

function renderSvgToRaster({ format, outputPath, size, sourcePath }) {
  const args = ["-s", "format", format];
  if (size) {
    args.push("-z", String(size), String(size));
  }
  args.push(sourcePath, "--out", outputPath);
  execFileSync("sips", args, { stdio: "ignore" });
}

function writeIco(targetPath, entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const dirOffset = index * 16;
    directory.writeUInt8(entry.width >= 256 ? 0 : entry.width, dirOffset);
    directory.writeUInt8(entry.height >= 256 ? 0 : entry.height, dirOffset + 1);
    directory.writeUInt8(0, dirOffset + 2);
    directory.writeUInt8(0, dirOffset + 3);
    directory.writeUInt16LE(1, dirOffset + 4);
    directory.writeUInt16LE(32, dirOffset + 6);
    directory.writeUInt32LE(entry.buffer.length, dirOffset + 8);
    directory.writeUInt32LE(offset, dirOffset + 12);
    offset += entry.buffer.length;
  });

  const content = Buffer.concat([
    header,
    directory,
    ...entries.map((entry) => entry.buffer),
  ]);
  fs.writeFileSync(targetPath, content);
}

function main() {
  ensureMacTool("sips");

  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(electrobunAssetsDir, { recursive: true });
  fs.rmSync(appIconsetDir, { force: true, recursive: true });
  fs.mkdirSync(appIconsetDir, { recursive: true });

  if (!fs.existsSync(faviconSvgPath)) {
    throw new Error(`Missing icon source: ${faviconSvgPath}`);
  }
  if (!fs.existsSync(splashSvgPath)) {
    throw new Error(`Missing splash source: ${splashSvgPath}`);
  }

  for (const [filename, size] of ICONSET_SIZES) {
    renderSvgToRaster({
      format: "png",
      outputPath: path.join(appIconsetDir, filename),
      size,
      sourcePath: faviconSvgPath,
    });
  }

  renderSvgToRaster({
    format: "png",
    outputPath: appIconPngPath,
    size: 512,
    sourcePath: faviconSvgPath,
  });

  const icoEntries = [32, 256].map((size) => {
    const pngPath = path.join(
      appIconsetDir,
      size === 32 ? "icon_32x32.png" : "icon_128x128@2x.png",
    );
    return {
      width: size,
      height: size,
      buffer: fs.readFileSync(pngPath),
    };
  });
  writeIco(appIconIcoPath, icoEntries);

  renderSvgToRaster({
    format: "jpeg",
    outputPath: splashJpgPath,
    sourcePath: splashSvgPath,
  });
}

main();
