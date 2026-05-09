import type http from "node:http";
import { sendJson } from "@elizaos/shared";

const EMPTY_APPROVAL_SNAPSHOT = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
} as const;

function sendEmptyApprovalStream(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({ type: "snapshot", snapshot: EMPTY_APPROVAL_SNAPSHOT })}\n\n`,
  );
}

export async function handleComputerUseRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/computer-use/")) {
    return false;
  }

  if (method === "GET" && pathname === "/api/computer-use/approvals") {
    sendJson(res, EMPTY_APPROVAL_SNAPSHOT);
    return true;
  }

  if (method === "GET" && pathname === "/api/computer-use/approvals/stream") {
    sendEmptyApprovalStream(res);
    req.on("close", () => {
      res.end();
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/computer-use/approval-mode") {
    sendJson(res, { mode: EMPTY_APPROVAL_SNAPSHOT.mode });
    return true;
  }

  const approvalDecision = /^\/api\/computer-use\/approvals\/([^/]+)$/.exec(
    pathname,
  );
  if (method === "POST" && approvalDecision) {
    sendJson(
      res,
      {
        error: "Computer-use approval is not pending.",
        id: decodeURIComponent(approvalDecision[1] ?? ""),
      },
      404,
    );
    return true;
  }

  return false;
}
