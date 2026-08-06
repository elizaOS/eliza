import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function POST(request: NextRequest) {
  let body: { path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { path: filePath, content } = body;
  if (!filePath || content === undefined) {
    return NextResponse.json(
      { error: "path and content are required" },
      { status: 400 }
    );
  }

  const resolvedPath = path.resolve(filePath);

  try {
    await fs.writeFile(resolvedPath, content, "utf-8");
    const stats = await fs.stat(resolvedPath);
    return NextResponse.json({ success: true, size: stats.size });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
