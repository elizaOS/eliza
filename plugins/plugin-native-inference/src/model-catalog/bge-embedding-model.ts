/** Pins the native BGE artifact and representation shared by desktop and mobile loaders. */
export const BGE_EMBEDDING_MODEL = {
  filename: "bge-small-en-v1.5-f16.gguf",
  repository: "CompendiumLabs/bge-small-en-v1.5-gguf",
  revision: "d32f8c040ea3b516330eeb75b72bcc2d3a780ab7",
  sha256: "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999",
  sizeBytes: 67_308_128,
  dimensions: 384,
  contextSize: 512,
  pooling: "cls",
} as const;
