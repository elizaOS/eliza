/**
 * Image comparison helpers provide low-resolution visual readiness signals for
 * device evidence capture without depending on platform accessibility APIs.
 */
import sharp from "sharp";

const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 64;

async function sampleRgb(imagePath) {
  return sharp(imagePath)
    .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
}

export async function normalizedImageDifference(referencePath, candidatePath) {
  const [reference, candidate] = await Promise.all([
    sampleRgb(referencePath),
    sampleRgb(candidatePath),
  ]);
  if (reference.length !== candidate.length || reference.length === 0) {
    throw new Error("device image samples have incompatible dimensions");
  }
  let difference = 0;
  for (let index = 0; index < reference.length; index += 1) {
    difference += Math.abs(reference[index] - candidate[index]);
  }
  return difference / (reference.length * 255);
}
