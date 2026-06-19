import { NextResponse } from "next/server";

export const runtime = "nodejs";

const apiDocsHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Feed API Docs</title>
    <link rel="stylesheet" href="/api-docs/assets/swagger-ui.css" />
    <style>
      :root {
        color-scheme: light;
        font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
        background: #f6efe4;
        color: #171311;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(219, 139, 78, 0.18), transparent 32%),
          linear-gradient(180deg, #f8f1e8 0%, #f5eee6 100%);
      }

      main {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      header {
        margin-bottom: 24px;
        padding: 24px 28px;
        border: 1px solid rgba(116, 79, 48, 0.18);
        border-radius: 24px;
        background: rgba(255, 250, 245, 0.92);
        box-shadow: 0 18px 48px rgba(72, 43, 18, 0.08);
      }

      h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1;
      }

      p {
        margin: 12px 0 0;
        max-width: 720px;
        color: rgba(23, 19, 17, 0.76);
        font-size: 1rem;
      }

      .actions {
        display: flex;
        gap: 12px;
        margin-top: 18px;
        flex-wrap: wrap;
      }

      .actions a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px 14px;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 600;
      }

      .actions a.primary {
        background: #171311;
        color: #fffaf5;
      }

      .actions a.secondary {
        border: 1px solid rgba(116, 79, 48, 0.18);
        color: #171311;
        background: rgba(255, 250, 245, 0.88);
      }

      #swagger-ui {
        min-height: 70vh;
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 18px 48px rgba(72, 43, 18, 0.08);
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Feed API Docs</h1>
        <p>
          Interactive OpenAPI documentation for Feed routes. The JSON spec is
          generated from the route annotations in this repository.
        </p>
        <div class="actions">
          <a class="primary" href="/api/docs">Open JSON Spec</a>
          <a class="secondary" href="https://github.com/FeedSocial/feed">
            Repository
          </a>
        </div>
      </header>
      <div id="swagger-ui"></div>
    </main>
    <script src="/api-docs/assets/swagger-ui-bundle.js"></script>
    <script src="/api-docs/swagger-ui-bootstrap.js"></script>
  </body>
</html>
`;

export function GET() {
  return new NextResponse(apiDocsHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
