import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { sandboxService } from "@/lib/services/sandbox";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

// GET /api/v1/app-builder/sessions/[sessionId]/files
// List files in the sandbox
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    // Verify session ownership
    const session = await aiAppBuilder.getSession(sessionId, user.id);
    if (!session) {
      return NextResponse.json(
        { success: false, error: "Session not found" },
        { status: 404 },
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get("path") || ".";

    const allFiles = await sandboxService.listFiles(session.sandboxId, path);

    // Filter out hidden directories and common non-source directories
    const EXCLUDED_PATTERNS = [
      /^\.git\//,
      /\/\.git\//,
      /^\.next\//,
      /\/\.next\//,
      /^node_modules\//,
      /\/node_modules\//,
      /^\.pnpm\//,
      /\/\.pnpm\//,
      /^\.cache\//,
      /\/\.cache\//,
      /^dist\//,
      /\/dist\//,
      /^\.turbo\//,
      /\/\.turbo\//,
      /\.lock$/,
      /lock\.json$/,
    ];

    const files = allFiles.filter((file) => {
      // Normalize path for matching
      const normalized = file.startsWith("./") ? file.slice(2) : file;
      return !EXCLUDED_PATTERNS.some((pattern) => pattern.test(normalized));
    });

    // Build a tree structure
    const fileTree = buildFileTree(files, path);

    return NextResponse.json({
      success: true,
      files,
      tree: fileTree,
    });
  } catch (error) {
    logger.error("Failed to list sandbox files", { error });
    const message =
      error instanceof Error ? error.message : "Failed to list files";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

// POST /api/v1/app-builder/sessions/[sessionId]/files
// Read or write a file
const FileOperationSchema = z.object({
  operation: z.enum(["read", "write"]),
  path: z.string().min(1),
  content: z.string().optional(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    // Verify session ownership
    const session = await aiAppBuilder.getSession(sessionId, user.id);
    if (!session) {
      return NextResponse.json(
        { success: false, error: "Session not found" },
        { status: 404 },
      );
    }

    const body = await request.json();
    const validation = FileOperationSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request",
          details: validation.error.format(),
        },
        { status: 400 },
      );
    }

    const { operation, path, content } = validation.data;

    if (operation === "read") {
      const fileContent = await sandboxService.readFile(
        session.sandboxId,
        path,
      );
      return NextResponse.json({
        success: true,
        content: fileContent,
        path,
      });
    } else if (operation === "write") {
      if (content === undefined) {
        return NextResponse.json(
          { success: false, error: "Content required for write operation" },
          { status: 400 },
        );
      }
      await sandboxService.writeFile(session.sandboxId, path, content);
      return NextResponse.json({
        success: true,
        message: "File written successfully",
        path,
      });
    }

    return NextResponse.json(
      { success: false, error: "Invalid operation" },
      { status: 400 },
    );
  } catch (error) {
    logger.error("Failed to perform file operation", { error });
    const message =
      error instanceof Error
        ? error.message
        : "Failed to perform file operation";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

function buildFileTree(files: string[], basePath: string): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const nodeMap = new Map<string, FileTreeNode>();

  // Sort files to ensure directories come before their contents
  const sortedFiles = [...files].sort();

  for (const filePath of sortedFiles) {
    // Normalize path - remove leading ./ or basePath
    let normalizedPath = filePath;
    if (normalizedPath.startsWith("./")) {
      normalizedPath = normalizedPath.slice(2);
    }
    if (basePath !== "." && normalizedPath.startsWith(basePath + "/")) {
      normalizedPath = normalizedPath.slice(basePath.length + 1);
    }

    const parts = normalizedPath.split("/").filter(Boolean);
    let currentPath = "";
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let node = nodeMap.get(currentPath);

      if (!node) {
        node = {
          name: part,
          path: filePath.startsWith("./") ? filePath : `./${filePath}`,
          type: isFile ? "file" : "directory",
          children: isFile ? undefined : [],
        };
        nodeMap.set(currentPath, node);
        currentLevel.push(node);
      }

      if (!isFile && node.children) {
        currentLevel = node.children;
      }
    }
  }

  // Sort: directories first, then alphabetically
  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((node) => ({
        ...node,
        children: node.children ? sortNodes(node.children) : undefined,
      }));
  };

  return sortNodes(root);
}
