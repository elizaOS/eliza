/** Renders safe markdown prose inside orchestrator transcripts. */

import {
  Card,
  Checkbox,
  CodeBlock,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextLink,
} from "@elizaos/ui";
import { marked, type Token, type Tokens, type TokensList } from "marked";
import type { ReactNode } from "react";
import { sanitizeMarkdownUrl } from "./orchestrator-markdown.helpers";

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
      return (
        <CodeBlock
          key={key}
          value={token.text}
          wrap
          copyable
          aria-label={token.lang ? `${token.lang} code` : "Code"}
          className="my-1 max-h-72 text-2xs leading-relaxed"
        />
      );
    case "blockquote":
      return (
        <blockquote key={key} className="relative my-1 pl-3 text-muted-strong">
          <Separator
            orientation="vertical"
            className="absolute inset-y-0 left-0 w-0.5"
          />
          {renderChildren(token.tokens, key)}
        </blockquote>
      );
    case "list": {
      const items = token.items.map((item: Tokens.ListItem, index: number) => {
        // Composite path key (parent path + position): stable across this
        // immutable, fully-recomputed AST render, and unique among siblings.
        const itemKey = `${key}.${index}`;
        return (
          <li key={itemKey} className="my-0.5 marker:text-muted">
            {item.task ? (
              <Checkbox
                checked={Boolean(item.checked)}
                disabled
                aria-hidden
                className="mr-1.5 align-middle"
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
          <Table density="dense">
            <TableHeader>
              <TableRow>
                {token.header.map((cell: Tokens.TableCell, index: number) => {
                  const cellKey = `${key}.h${index}`;
                  return (
                    <TableHead
                      key={cellKey}
                      style={alignStyle(cell.align)}
                      divider="subtle"
                      className="h-auto px-2 py-1 text-left font-semibold normal-case tracking-normal"
                    >
                      {renderChildren(cell.tokens, cellKey)}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {token.rows.map((row: Tokens.TableCell[], rowIndex: number) => {
                const rowKey = `${key}.r${rowIndex}`;
                return (
                  <TableRow key={rowKey}>
                    {row.map((cell: Tokens.TableCell, cellIndex: number) => {
                      const cellKey = `${rowKey}c${cellIndex}`;
                      return (
                        <TableCell
                          key={cellKey}
                          style={alignStyle(cell.align)}
                          variant="divided"
                          className="px-2 py-1 align-top"
                        >
                          {renderChildren(cell.tokens, cellKey)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      );
    case "hr":
      return <Separator key={key} className="my-2" tone="subtle40" />;
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
        <CodeBlock
          key={key}
          variant="inline"
          size="prose"
          tone="strong"
          className="break-words px-1 py-px"
        >
          {token.text}
        </CodeBlock>
      );
    case "link": {
      const href = sanitizeMarkdownUrl(token.href);
      // Only open external (http/https/mailto) links in a new tab.
      // Relative paths should navigate in the same context.
      const isExternal = href !== null && /^https?:/i.test(href);
      return (
        <TextLink
          key={key}
          href={href ?? undefined}
          title={token.title ?? undefined}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noreferrer" : undefined}
        >
          {renderChildren(token.tokens, key)}
        </TextLink>
      );
    }
    case "image": {
      const src = sanitizeMarkdownUrl(token.href);
      if (!src) return token.text;
      return (
        <Card key={key} asChild surface="transparent" border="subtle">
          <img
            src={src}
            alt={token.text}
            title={token.title ?? undefined}
            className="my-1 max-w-full"
          />
        </Card>
      );
    }
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

export function MarkdownText({ text }: { text: string }): ReactNode {
  // marked.lexer runs synchronously here. It can throw — a stack overflow on
  // pathologically nested input, or a TypeError on a non-string. A throw in
  // this render would unmount the whole conversation, so degrade to plain text.
  let tokens: TokensList;
  try {
    tokens = marked.lexer(text);
  } catch {
    return (
      <div className="whitespace-pre-wrap break-words text-xs text-txt">
        {text}
      </div>
    );
  }
  return (
    <div className="break-words text-xs text-txt">
      {tokens.map((token, index) => renderToken(token, `t${index}`))}
    </div>
  );
}
