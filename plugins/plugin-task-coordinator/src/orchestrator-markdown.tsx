import { marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";

// The coding agent writes markdown prose. We parse it with `marked` — a real
// lexer, not a hand-rolled regex — then render its token AST directly to React
// elements. Rendering the AST (rather than marked's HTML string) means nothing
// is ever injected via dangerouslySetInnerHTML: raw HTML that appears in the
// stream is shown as escaped text, never executed, so there's no XSS surface
// and no sanitizer dependency. marked is pure ESM with zero dependencies, so it
// also sidesteps the rolldown dev-optimizer's CommonJS-interop hang that
// react-markdown's `style-to-js` dep triggers in this app.

function alignStyle(align: Tokens.TableCell["align"]) {
  return align ? { textAlign: align } : undefined;
}

function renderChildren(tokens: Token[] | undefined, key: string): ReactNode {
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token, index) => renderToken(token, `${key}.${index}`));
}

function renderToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return (
        <p key={key} className="my-1 leading-relaxed first:mt-0 last:mb-0">
          {renderChildren(token.tokens, key)}
        </p>
      );
    case "heading": {
      const depth = Math.min(Math.max(token.depth, 1), 4);
      const Tag = `h${depth}` as "h1" | "h2" | "h3" | "h4";
      return (
        <Tag key={key} className="mt-2 mb-1 font-semibold text-txt first:mt-0">
          {renderChildren(token.tokens, key)}
        </Tag>
      );
    }
    case "code":
      return <CodeBlock key={key} code={token.text} lang={token.lang} />;
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="my-1 border-l-2 border-border pl-3 text-muted-strong"
        >
          {renderChildren(token.tokens, key)}
        </blockquote>
      );
    case "list": {
      const items = token.items.map((item, index) => {
        // Composite path key (parent path + position): stable across this
        // immutable, fully-recomputed AST render, and unique among siblings.
        const itemKey = `${key}.${index}`;
        return (
          <li key={itemKey} className="my-0.5 marker:text-muted">
            {item.task ? (
              <input
                type="checkbox"
                checked={Boolean(item.checked)}
                readOnly
                aria-hidden
                className="mr-1.5 align-middle accent-accent"
              />
            ) : null}
            {renderChildren(item.tokens, itemKey)}
          </li>
        );
      });
      return token.ordered ? (
        <ol
          key={key}
          start={typeof token.start === "number" ? token.start : undefined}
          className="my-1 list-decimal space-y-0.5 pl-5"
        >
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className="my-1.5 overflow-x-auto">
          <table className="w-full border-collapse text-2xs">
            <thead>
              <tr>
                {token.header.map((cell, index) => {
                  const cellKey = `${key}.h${index}`;
                  return (
                    <th
                      key={cellKey}
                      style={alignStyle(cell.align)}
                      className="border border-border/60 bg-bg/40 px-2 py-1 text-left font-semibold text-txt"
                    >
                      {renderChildren(cell.tokens, cellKey)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((row, rowIndex) => {
                const rowKey = `${key}.r${rowIndex}`;
                return (
                  <tr key={rowKey}>
                    {row.map((cell, cellIndex) => {
                      const cellKey = `${rowKey}c${cellIndex}`;
                      return (
                        <td
                          key={cellKey}
                          style={alignStyle(cell.align)}
                          className="border border-border/50 px-2 py-1 align-top"
                        >
                          {renderChildren(cell.tokens, cellKey)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} className="my-2 border-border/50" />;
    case "strong":
      return (
        <strong key={key} className="font-semibold text-txt">
          {renderChildren(token.tokens, key)}
        </strong>
      );
    case "em":
      return (
        <em key={key} className="italic">
          {renderChildren(token.tokens, key)}
        </em>
      );
    case "del":
      return (
        <del key={key} className="line-through opacity-80">
          {renderChildren(token.tokens, key)}
        </del>
      );
    case "codespan":
      return (
        <code
          key={key}
          className="rounded-sm bg-bg/70 px-1 py-px font-mono text-[0.95em] text-txt-strong"
        >
          {token.text}
        </code>
      );
    case "link":
      return (
        <a
          key={key}
          href={token.href}
          title={token.title ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="text-txt-strong underline underline-offset-2 transition-colors hover:text-accent"
        >
          {renderChildren(token.tokens, key)}
        </a>
      );
    case "image":
      return (
        <img
          key={key}
          src={token.href}
          alt={token.text}
          title={token.title ?? undefined}
          className="my-1 max-w-full rounded-sm border border-border/50"
        />
      );
    case "br":
      return <br key={key} />;
    case "escape":
      return token.text;
    case "text":
      // A block-level text token (e.g. loose-list content) carries inline
      // tokens; an inline text leaf is just its string.
      return token.tokens && token.tokens.length > 0
        ? renderChildren(token.tokens, key)
        : token.text;
    default:
      // `html` and any other raw tokens are rendered as escaped text — never
      // injected as markup — so stray tags in the stream can't execute.
      return "raw" in token ? token.raw : null;
  }
}

function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  return (
    <div className="my-1 overflow-hidden rounded-sm border border-border/50 bg-bg/80">
      {lang ? (
        <div className="border-b border-border/40 px-2.5 py-0.5 font-mono text-3xs uppercase tracking-wide text-muted">
          {lang}
        </div>
      ) : null}
      <pre className="max-h-72 overflow-auto px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-txt">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownText({ text }: { text: string }): ReactNode {
  const tokens = marked.lexer(text);
  return (
    <div className="break-words text-xs text-txt">
      {tokens.map((token, index) => renderToken(token, `t${index}`))}
    </div>
  );
}
