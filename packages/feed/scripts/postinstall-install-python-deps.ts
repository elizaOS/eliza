#!/usr/bin/env bun

/**
 * Post-install script to install Python dependencies for training and agent examples
 * Ensures Python projects can run after npm/bun install
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface PythonProject {
  name: string;
  path: string;
  useUv: boolean;
}

const PYTHON_PROJECTS: PythonProject[] = [
  {
    name: "Training Pipeline",
    path: join(process.cwd(), "packages/training/python"),
    useUv: false, // Uses pip/venv - has existing venv
  },
  {
    name: "LangGraph Agent Example",
    path: join(process.cwd(), "packages/examples/feed-langgraph-agent"),
    useUv: true, // Uses uv - has uv.lock
  },
];

async function checkPythonInstalled(): Promise<boolean> {
  try {
    execSync("python3 --version", { stdio: "ignore" });
    return true;
  } catch {
    try {
      execSync("python --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

async function checkUvInstalled(): Promise<boolean> {
  try {
    execSync("uv --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function installProjectDeps(
  project: PythonProject,
  hasUv: boolean,
): Promise<void> {
  if (!existsSync(project.path)) {
    console.log(`   ⏭️  ${project.name} directory not found, skipping`);
    return;
  }

  // Check if pyproject.toml or requirements.txt exists
  const hasPyproject = existsSync(join(project.path, "pyproject.toml"));
  const hasRequirements = existsSync(join(project.path, "requirements.txt"));

  if (!hasPyproject && !hasRequirements) {
    console.log(`   ⏭️  ${project.name} has no Python config, skipping`);
    return;
  }

  if (project.useUv) {
    if (!hasUv) {
      console.log(`   ⚠️  ${project.name}: uv not found, skipping`);
      console.log(
        `   💡 Install uv (https://github.com/astral-sh/uv) to use this project`,
      );
      return;
    }

    try {
      console.log(`   📦 ${project.name}: Installing with uv...`);
      execSync("uv sync --prerelease=allow", {
        cwd: project.path,
        stdio: "inherit",
      });
      console.log(`   ✅ ${project.name}: Dependencies installed`);
    } catch (_error) {
      console.log(`   ⚠️  ${project.name}: Failed to install dependencies`);
      console.log(
        `   💡 Run manually: cd ${project.path} && uv sync --prerelease=allow`,
      );
    }
  } else {
    // Check if venv already exists
    const venvPath = join(project.path, "venv");
    if (existsSync(venvPath)) {
      console.log(
        `   ✅ ${project.name}: venv already exists, skipping install`,
      );
      console.log(
        `   💡 To reinstall: cd ${project.path} && pip install -r requirements.txt`,
      );
      return;
    }

    // No venv - guide user to set up
    console.log(`   ⏭️  ${project.name}: No venv found`);
    console.log(
      `   💡 To set up: cd ${project.path} && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`,
    );
  }
}

async function installPythonDeps(): Promise<void> {
  console.log("🐍 Checking Python dependencies...");

  const hasPython = await checkPythonInstalled();
  if (!hasPython) {
    console.log(
      "   ⚠️  Python not found, skipping Python dependency installation",
    );
    console.log("   💡 Install Python 3.11+ to use Python projects");
    return;
  }

  const hasUv = await checkUvInstalled();

  for (const project of PYTHON_PROJECTS) {
    await installProjectDeps(project, hasUv);
  }

  console.log("   ✅ Python dependency check complete");
}

installPythonDeps().catch((error) => {
  console.error("Error installing Python dependencies:", error);
  process.exit(1);
});
