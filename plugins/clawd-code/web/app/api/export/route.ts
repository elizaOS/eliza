import { NextRequest, NextResponse } from "next/server";
import type { Conversation, ExportOptions } from "@/lib/types";
import { toMarkdown } from "@/lib/export/markdown";
import { toJSON } from "@/lib/export/json";
import { toHTML } from "@/lib/export/html";
import { toPlainText } from "@/lib/export/plaintext";

interface ExportRequest {
  conversation: Conversation;
  options: ExportOptions;
}

const MIME: Record<string, string> = {
  markdown: "text/markdown; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  plaintext: "text/plain; charset=utf-8",
};

const EXT: Record<string, string> = {
  markdown: "md",
  json: "json",
  html: "html",
  plaintext: "txt",
};

export async function POST(req: NextRequest) {
  let body: ExportRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { conversation, options } = body;
  if (!conversation || !options) {
    return NextResponse.json(
      { error: "Missing conversation or options" },
      { status: 400 }
    );
  }

  const { format } = options;

  if (format === "pdf") {
    // PDF is handled client-side via window.print()
    return NextResponse.json(
      { error: "PDF export is handled client-side" },
      { status: 400 }
    );
  }

  let content: string;
  switch (format) {
    case "markdown":
      content = toMarkdown(conversation, options);
      break;
    case "json":
      content = toJSON(conversation, options);
      break;
    case "html":
      content = toHTML(conversation, options);
      break;
    case "plaintext":
      content = toPlainText(conversation, options);
      break;
    default:
      return NextResponse.json({ error: `Unknown format: ${format}` }, { status: 400 });
  }

  const slug = conversation.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const filename = `${slug || "conversation"}.${EXT[format]}`;

  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": MIME[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
