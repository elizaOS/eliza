import fs from "node:fs";

const DISPATCH_RE = /ggml_vk_dispatch_pipeline\(([^,\s)]+)/g;
const MUL_MAT_RE =
  /ggml_vk_(mul_mat(?:_id)?_q_f16)\(\([^)]*name=([^,)]*)[^)]*type=([^,)]*)[^)]*ne0=([0-9]+)[^)]*ne1=([0-9]+)[^)]*ne2=([0-9]+)[^)]*ne3=([0-9]+)/g;

function emptySummary() {
  return {
    totalDispatches: 0,
    matmulDispatches: 0,
    subgroupDispatches: 0,
    q8_1Dispatches: 0,
    genericMatmulDispatches: 0,
    splitKDispatches: 0,
    topPipelines: [],
    matmulOps: [],
  };
}

function classifyPipeline(name) {
  const isMatmul =
    name.includes("matmul") ||
    name.includes("mul_mat") ||
    name === "mul_mat_mat_split_k_reduce";
  return {
    isMatmul,
    isSubgroup: name.includes("_subgroup_"),
    isQ8_1: name.includes("_q8_1"),
    isSplitK: name.includes("split_k"),
    isGenericMatmul:
      isMatmul && !name.includes("_subgroup_") && !name.includes("split_k"),
  };
}

export function analyzeVulkanDispatchLog(text) {
  const pipelineCounts = new Map();
  const matmulOps = [];
  const summary = emptySummary();

  for (const match of text.matchAll(MUL_MAT_RE)) {
    matmulOps.push({
      op: match[1],
      tensor: match[2].trim(),
      src0Type: match[3].trim(),
      src0Shape: [
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
        Number(match[7]),
      ],
    });
  }

  for (const match of text.matchAll(DISPATCH_RE)) {
    const pipeline = match[1];
    pipelineCounts.set(pipeline, (pipelineCounts.get(pipeline) ?? 0) + 1);
    summary.totalDispatches += 1;

    const cls = classifyPipeline(pipeline);
    if (cls.isMatmul) summary.matmulDispatches += 1;
    if (cls.isSubgroup) summary.subgroupDispatches += 1;
    if (cls.isQ8_1) summary.q8_1Dispatches += 1;
    if (cls.isGenericMatmul) summary.genericMatmulDispatches += 1;
    if (cls.isSplitK) summary.splitKDispatches += 1;
  }

  summary.topPipelines = [...pipelineCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([name, count]) => ({ name, count, ...classifyPipeline(name) }));
  summary.matmulOps = matmulOps.slice(0, 50);

  return summary;
}

function formatSummary(summary) {
  const lines = [
    `dispatches.total=${summary.totalDispatches}`,
    `dispatches.matmul=${summary.matmulDispatches}`,
    `dispatches.matmul.subgroup=${summary.subgroupDispatches}`,
    `dispatches.matmul.q8_1=${summary.q8_1Dispatches}`,
    `dispatches.matmul.generic=${summary.genericMatmulDispatches}`,
    `dispatches.matmul.split_k=${summary.splitKDispatches}`,
    "",
    "top_pipelines:",
  ];

  for (const pipeline of summary.topPipelines) {
    const tags = [
      pipeline.isSubgroup ? "subgroup" : null,
      pipeline.isQ8_1 ? "q8_1" : null,
      pipeline.isGenericMatmul ? "generic" : null,
      pipeline.isSplitK ? "split_k" : null,
    ].filter(Boolean);
    lines.push(
      `  ${String(pipeline.count).padStart(5)}  ${pipeline.name}${
        tags.length ? `  [${tags.join(",")}]` : ""
      }`,
    );
  }

  if (summary.matmulOps.length > 0) {
    lines.push("", "first_matmul_ops:");
    for (const op of summary.matmulOps.slice(0, 10)) {
      lines.push(
        `  ${op.op} ${op.tensor} ${op.src0Type} src0=[${op.src0Shape.join(
          ",",
        )}]`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function compareVulkanDispatchLogs(leftText, rightText) {
  const left = analyzeVulkanDispatchLog(leftText);
  const right = analyzeVulkanDispatchLog(rightText);
  return {
    left,
    right,
    delta: {
      matmulDispatches: right.matmulDispatches - left.matmulDispatches,
      subgroupDispatches: right.subgroupDispatches - left.subgroupDispatches,
      q8_1Dispatches: right.q8_1Dispatches - left.q8_1Dispatches,
      genericMatmulDispatches:
        right.genericMatmulDispatches - left.genericMatmulDispatches,
      splitKDispatches: right.splitKDispatches - left.splitKDispatches,
    },
  };
}

function usage() {
  return [
    "Usage:",
    "  node packages/app-core/scripts/kernel-patches/vulkan-dispatch-log.mjs <log>",
    "  node packages/app-core/scripts/kernel-patches/vulkan-dispatch-log.mjs <baseline.log> <candidate.log>",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (files.length < 1 || files.length > 2) {
    console.error(usage());
    process.exit(2);
  }

  const [leftFile, rightFile] = files;
  const leftText = fs.readFileSync(leftFile, "utf8");

  if (!rightFile) {
    process.stdout.write(formatSummary(analyzeVulkanDispatchLog(leftText)));
    process.exit(0);
  }

  const rightText = fs.readFileSync(rightFile, "utf8");
  const compared = compareVulkanDispatchLogs(leftText, rightText);
  process.stdout.write("baseline:\n");
  process.stdout.write(formatSummary(compared.left));
  process.stdout.write("\ncandidate:\n");
  process.stdout.write(formatSummary(compared.right));
  process.stdout.write("\ndelta:\n");
  for (const [key, value] of Object.entries(compared.delta)) {
    process.stdout.write(`  ${key}=${value >= 0 ? "+" : ""}${value}\n`);
  }
}
