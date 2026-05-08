import { describe, expect, it } from "vitest";
import {
  closeUnbalancedMarkdownFences,
  extractCompletionSummary,
  formatMarkdownTablesForChat,
  summarizeUserFacingTurnOutput,
} from "../services/ansi-utils.js";

describe("extractCompletionSummary", () => {
  it("uses the final assistant block instead of app guidance from the prompt transcript", () => {
    const raw = [
      "user",
      "Build apps with Eliza Cloud when appropriate.",
      "Want me to buy one of these for you?",
      "appId: <APP_ID>",
      "custom domain options (one-time, paid from your cloud credits):",
      "monetization: enabled for app chat inference",
      "auth: eliza cloud oauth",
      "https://example.com",
      "https://cloud.example.com",
      "codex",
      "Disk check: `/dev/sda1` is 95% used with 22G free. Urgent: cleanup should happen now.",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      "Disk check: `/dev/sda1` is 95% used with 22G free. Urgent: cleanup should happen now.",
    );
  });

  it("keeps normal app result summaries from the final assistant block", () => {
    const raw = [
      "codex",
      "Built Pocket Breath.",
      "URL: https://example.com/apps/pocket-breath/",
      "Verified: public 200 OK and controls work.",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Built Pocket Breath.",
        "URL: https://example.com/apps/pocket-breath/",
        "Verified: public 200 OK and controls work.",
      ].join("\n"),
    );
  });

  it("keeps the whole app result block when verification follows changed files", () => {
    const raw = [
      "Built the static app at:",
      "",
      "URL: https://example.com/apps/tiny-stretch-timer/",
      "",
      "Files changed:",
      "- `data/apps/tiny-stretch-timer/index.html`",
      "- `data/apps/tiny-stretch-timer/style.css`",
      "- `data/apps/tiny-stretch-timer/app.js`",
      "- `data/apps/tiny-stretch-timer/meta.json`",
      "",
      "Verified:",
      "- `node --check` passed for `app.js`",
      "- Local route returned `200 OK`",
      "- Public route returned `200 OK`",
      "",
      "Browser automation was not available: Chromium is not installed.",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Built the static app at:",
        "",
        "URL: https://example.com/apps/tiny-stretch-timer/",
        "",
        "Files changed:",
        "- `data/apps/tiny-stretch-timer/index.html`",
        "- `data/apps/tiny-stretch-timer/style.css`",
        "- `data/apps/tiny-stretch-timer/app.js`",
        "- `data/apps/tiny-stretch-timer/meta.json`",
        "",
        "Verified:",
        "- `node --check` passed for `app.js`",
        "- Local route returned `200 OK`",
        "- Public route returned `200 OK`",
        "",
        "Browser automation was not available: Chromium is not installed.",
      ].join("\n"),
    );
  });

  it("drops a bare duplicate URL when the final block also has a sourced line", () => {
    const raw = [
      "codex",
      "https://api.example.test/v1/market/asset-usd",
      "Asset/USD spot price: $79,821.015",
      "Source: Market Spot Price API https://api.example.test/v1/market/asset-usd",
      "UTC timestamp: 2026-05-07T17:11:49.779Z",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Asset/USD spot price: $79,821.015",
        "Source: Market Spot Price API https://api.example.test/v1/market/asset-usd",
        "UTC timestamp: 2026-05-07T17:11:49.779Z",
      ].join("\n"),
    );
  });

  it("keeps a standalone URL when it is the value for the preceding heading", () => {
    const raw = [
      "codex",
      "Built the app at:",
      "",
      "https://example.com/apps/breathing-timer/",
      "",
      "Verified:",
      "- Public URL plus CSS/JS assets return `200` at https://example.com/apps/breathing-timer/",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Built the app at:",
        "",
        "https://example.com/apps/breathing-timer/",
        "",
        "Verified:",
        "- Public URL plus CSS/JS assets return `200` at https://example.com/apps/breathing-timer/",
      ].join("\n"),
    );
  });

  it("keeps heading value lines between URL and verification sections", () => {
    const raw = [
      "Built the tiny ambient app here:",
      "",
      "https://example.com/apps/ambient-clock/",
      "",
      "Files added:",
      "`data/apps/ambient-clock/{index.html,style.css,app.js,meta.json}`",
      "",
      "Verified:",
      "- `node --check data/apps/ambient-clock/app.js`",
      "- Public HTTP + assets: `https://example.com/apps/ambient-clock/`, `style.css`, `app.js`",
      "",
      "Browser automation was not available in this environment.",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Built the tiny ambient app here:",
        "",
        "https://example.com/apps/ambient-clock/",
        "",
        "Files added:",
        "`data/apps/ambient-clock/{index.html,style.css,app.js,meta.json}`",
        "",
        "Verified:",
        "- `node --check data/apps/ambient-clock/app.js`",
        "- Public HTTP + assets: https://example.com/apps/ambient-clock/, `style.css`, `app.js`",
        "",
        "Browser automation was not available in this environment.",
      ].join("\n"),
    );
  });
});

describe("summarizeUserFacingTurnOutput", () => {
  it("formats markdown tables as chat-friendly bullets", () => {
    const raw = [
      "Filesystem summary:",
      "",
      "| Mount | Size | Used | Avail | Use% |",
      "|---|---:|---:|---:|---:|",
      "| `/` | 100G | 92G | 8G | 92% |",
      "| `/boot` | 1G | 90M | 910M | 9% |",
      "",
      "Assessment: root needs cleanup soon.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Filesystem summary:",
        "- `/`: Size: 100G, Used: 92G, Avail: 8G, Use%: 92%",
        "- `/boot`: Size: 1G, Used: 90M, Avail: 910M, Use%: 9%",
        "Assessment: root needs cleanup soon.",
      ].join("\n"),
    );
  });

  it("preserves concise captured Codex final answers with verification", () => {
    const raw = [
      "transient correlation id",
      "",
      "Built the stretch break timer here: https://example.com/apps/stretch-break-timer/",
      "",
      "Changed `data/apps/stretch-break-timer/` with the app HTML/CSS/JS/meta. Verified `app.js` syntax, local route `200` for HTML/CSS/JS, and public route `200` for HTML/CSS/JS/meta.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Built the stretch break timer here: https://example.com/apps/stretch-break-timer/",
        "",
        "Changed `data/apps/stretch-break-timer/` with the app HTML/CSS/JS/meta. Verified `app.js` syntax, local route `200` for HTML/CSS/JS, and public route `200` for HTML/CSS/JS/meta.",
      ].join("\n"),
    );
  });

  it("dedupes a bare URL from concise captured answers when a sourced line has the same URL", () => {
    const raw = [
      "https://api.example.test/v1/market/asset-usd",
      "Asset/USD spot price: $79,821.015",
      "Source: Market Spot Price API https://api.example.test/v1/market/asset-usd",
      "UTC timestamp: 2026-05-07T17:11:49.779Z",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Asset/USD spot price: $79,821.015",
        "Source: Market Spot Price API https://api.example.test/v1/market/asset-usd",
        "UTC timestamp: 2026-05-07T17:11:49.779Z",
      ].join("\n"),
    );
  });

  it("unwraps inline-code URLs so Discord can autolink them", () => {
    const raw = [
      "Branch: `feature/example`",
      "Open PR: `#123`",
      "`https://github.com/example/project/pull/123`",
      "Remotes:",
      "- `origin`: `https://github.com/example/project.git`",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Branch: `feature/example`",
        "Open PR: `#123`",
        "https://github.com/example/project/pull/123",
        "Remotes:",
        "- `origin`: https://github.com/example/project.git",
      ].join("\n"),
    );
  });

  it("preserves generic structured summaries by shape instead of task keywords", () => {
    const raw = [
      "Result:",
      "Location: `https://example.com/reports/status`",
      "Checks:",
      "- first route returned `200`",
      "- second route returned `200`",
      "Outcome: ready for review.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Result:",
        "Location: https://example.com/reports/status",
        "Checks:",
        "- first route returned `200`",
        "- second route returned `200`",
        "Outcome: ready for review.",
      ].join("\n"),
    );
  });

  it("preserves markdown bullet summaries that include code-like text", () => {
    const raw = [
      "Changed:",
      "- `src/index.ts` now returns `ok`",
      "- `const ready = true` appears in the example",
      "- `README.md` documents the flow",
      "",
      "Verified:",
      "- `bun test` passed",
      "- `bun run typecheck` passed",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Changed:",
        "- `src/index.ts` now returns `ok`",
        "- `const ready = true` appears in the example",
        "- `README.md` documents the flow",
        "Verified:",
        "- `bun test` passed",
        "- `bun run typecheck` passed",
      ].join("\n"),
    );
  });

  it("preserves markdown bullet summaries even when most items include code punctuation", () => {
    const raw = [
      "Changed:",
      "- `src/index.ts`: returns `{ ok: true }`.",
      "- `src/server.ts`: exports `run()`.",
      "- `src/config.ts`: sets `mode = \"safe\"`.",
      "- `README.md`: documents `api()`.",
      "- `package.json`: adds the `test` script.",
      "",
      "Verified:",
      "- `bun test` passed.",
      "- `bun run typecheck` passed.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Changed:",
        "- `src/index.ts`: returns `{ ok: true }`.",
        "- `src/server.ts`: exports `run()`.",
        "- `src/config.ts`: sets `mode = \"safe\"`.",
        "- `README.md`: documents `api()`.",
        "- `package.json`: adds the `test` script.",
        "Verified:",
        "- `bun test` passed.",
        "- `bun run typecheck` passed.",
      ].join("\n"),
    );
  });

  it("collapses duplicated status summaries while keeping the richer repeated line", () => {
    const raw = [
      "Branch: `feature/link-precedence` at `46191f5c9`",
      "Worktree: clean.",
      "Upstream/tracking: `origin/develop`. Ahead/behind relative to `origin/develop`: `ahead 1, behind 1`.",
      "Open PR: `#123` open, `example:feature/link-precedence` `develop`",
      "`https://github.com/example/project/pull/123`",
      "Remotes:",
      "- `origin`: `https://github.com/example/project.git`",
      "- `fork`: `https://github.com/example-fork/project.git`",
      "No files changed.",
      "",
      "Branch: `feature/link-precedence` at `46191f5c9`",
      "",
      "Worktree: clean.",
      "",
      "Upstream/tracking: `origin/develop`. Ahead/behind relative to `origin/develop`: `ahead 1, behind 1`.",
      "",
      "Open PR: `#123` open, `example:feature/link-precedence` → `develop`",
      "`https://github.com/example/project/pull/123`",
      "",
      "Remotes:",
      "- `origin`: `https://github.com/example/project.git`",
      "- `fork`: `https://github.com/example-fork/project.git`",
      "",
      "No files changed.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Branch: `feature/link-precedence` at `46191f5c9`",
        "Worktree: clean.",
        "Upstream/tracking: `origin/develop`. Ahead/behind relative to `origin/develop`: `ahead 1, behind 1`.",
        "Open PR: `#123` open, `example:feature/link-precedence` `develop`",
        "https://github.com/example/project/pull/123",
        "Remotes:",
        "- `origin`: https://github.com/example/project.git",
        "- `fork`: https://github.com/example-fork/project.git",
        "No files changed.",
      ].join("\n"),
    );
  });
});

describe("formatMarkdownTablesForChat", () => {
  it("keeps fenced pipe text unchanged", () => {
    expect(
      formatMarkdownTablesForChat(
        [
          "Raw output:",
          "```text",
          "| a | b |",
          "|---|---|",
          "| 1 | 2 |",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Raw output:",
        "```text",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "```",
      ].join("\n"),
    );
  });
});

describe("closeUnbalancedMarkdownFences", () => {
  it("closes an unfinished fenced block before chat delivery", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Disk check: urgent.",
          "`df -h` source:",
          "```text",
          "/dev/sda1 387G 372G 15G 97% /",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Disk check: urgent.",
        "`df -h` source:",
        "```text",
        "/dev/sda1 387G 372G 15G 97% /",
        "```",
      ].join("\n"),
    );
  });

  it("closes plain command-output fences before following prose summaries", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Source: `status` run locally.",
          "```text",
          "Name State Size Used",
          "primary active 100G 98%",
          "secondary active 50G 12%",
          "Urgent: primary is near capacity and needs cleanup soon.",
          "Everything else shown is fine. No files changed.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Source: `status` run locally.",
        "```text",
        "Name State Size Used",
        "primary active 100G 98%",
        "secondary active 50G 12%",
        "```",
        "Urgent: primary is near capacity and needs cleanup soon.",
        "Everything else shown is fine. No files changed.",
      ].join("\n"),
    );
  });

  it("closes one-line command-output fences before following prose summaries", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Ran `status`.",
          "```text",
          "primary active 100G 98%",
          "That is urgent: primary is near capacity.",
          "No files changed.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Ran `status`.",
        "```text",
        "primary active 100G 98%",
        "```",
        "That is urgent: primary is near capacity.",
        "No files changed.",
      ].join("\n"),
    );
  });

  it("does not split literal text fences that contain prose only", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Example:",
          "```text",
          "This is a literal text sample.",
          "It contains sentences on purpose.",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Example:",
        "```text",
        "This is a literal text sample.",
        "It contains sentences on purpose.",
        "```",
      ].join("\n"),
    );
  });

  it("does not split non-plain code fences before prose-like code comments", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Patch:",
          "```ts",
          "const value = 1;",
          "// This comment intentionally looks like prose.",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Patch:",
        "```ts",
        "const value = 1;",
        "// This comment intentionally looks like prose.",
        "```",
      ].join("\n"),
    );
  });

  it("repairs nested fenced openers with info strings", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Branch: clean.",
          "```text",
          "## branch...origin/develop",
          "Remotes:",
          "```text",
          "origin https://github.com/example/repo.git",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Branch: clean.",
        "```text",
        "## branch...origin/develop",
        "Remotes:",
        "```",
        "```text",
        "origin https://github.com/example/repo.git",
        "```",
      ].join("\n"),
    );
  });
});
