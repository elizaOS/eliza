"use client";

interface JsonSyntaxHighlighterProps {
  value: string;
  onChange: (value: string) => void;
  isValid: boolean;
}

export function JsonSyntaxHighlighter({ value, onChange, isValid }: JsonSyntaxHighlighterProps) {
  const escapeHtml = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const highlightJson = (text: string) => {
    if (!text) return text;

    const lines = text.split("\n");
    return lines
      .map((line, lineIndex) => {
        let highlighted = escapeHtml(line);

        // Highlight brackets and braces first
        highlighted = highlighted.replace(
          /([{}[\]])/g,
          '<span style="color: #E434BB; font-weight: bold;">$1</span>',
        );

        // Highlight commas and colons
        highlighted = highlighted.replace(/([,:])/g, '<span style="color: #E434BB;">$1</span>');

        // Highlight keys (property names before colon)
        highlighted = highlighted.replace(
          /"([^"]+)"(\s*):/g,
          '<span style="color: #FE9F6D;">"$1"</span>$2<span style="color: #E434BB;">:</span>',
        );

        // Highlight string values (after colon, before comma or end)
        highlighted = highlighted.replace(
          /(:\s*)"([^"]*)"/g,
          '$1<span style="color: #D4D4D4;">"$2"</span>',
        );

        // Highlight numbers
        highlighted = highlighted.replace(
          /(:\s*)(\d+\.?\d*)/g,
          '$1<span style="color: #D4D4D4;">$2</span>',
        );

        // Highlight booleans and null
        highlighted = highlighted.replace(
          /(:\s*)(true|false|null)/g,
          '$1<span style="color: #D4D4D4;">$2</span>',
        );

        return `<div key="${lineIndex}">${highlighted}</div>`;
      })
      .join("");
  };

  return (
    <div className="relative h-full w-full">
      {/* Highlighted background layer */}
      <div
        className="absolute inset-0 overflow-auto p-4 font-mono text-sm pointer-events-none"
        style={{
          whiteSpace: "pre",
          wordWrap: "break-word",
          color: "transparent",
          caretColor: "transparent",
        }}
        dangerouslySetInnerHTML={{ __html: highlightJson(value) }}
      />

      {/* Editable textarea */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`absolute inset-0 w-full h-full p-4 resize-none font-mono text-sm bg-transparent border-0 outline-none ${
          isValid ? "" : "border-rose-500"
        }`}
        style={{
          color: "transparent",
          caretColor: "white",
          WebkitTextFillColor: "transparent",
          whiteSpace: "pre",
          wordWrap: "break-word",
        }}
        spellCheck={false}
        placeholder="Character JSON will appear here..."
      />
    </div>
  );
}
