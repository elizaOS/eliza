/**
 * Shared Markdown Components for App Builder
 *
 * Provides consistent markdown rendering across the app builder UI.
 * All elements include smooth entrance animations for streaming content.
 * Includes animated status icons for premium feel.
 */

import React from "react";

/**
 * Reasoning text with thought bubble icon
 */
function ReasoningText({ children }: { children: string }) {
  return (
    <span className="inline-flex items-start gap-1.5">
      <span className="flex-shrink-0">💭</span>
      <span>{children}</span>
    </span>
  );
}

/**
 * Animated checkmark SVG - fixed size for consistent alignment
 */
const AnimatedCheckInline = () => (
  <span className="flex items-center justify-center w-[14px] h-[14px] flex-shrink-0 mt-[3px]">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <style>
        {`
          @keyframes checkDrawInline {
            to { stroke-dashoffset: 0; }
          }
          .check-inline path {
            stroke-dasharray: 20;
            stroke-dashoffset: 20;
            animation: checkDrawInline 350ms cubic-bezier(0.65, 0, 0.35, 1) forwards;
          }
        `}
      </style>
      <g className="check-inline">
        <path
          d="M3 8.5L6.5 12L13 4"
          stroke="#34d399"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  </span>
);

/**
 * Animated loading spinner SVG - fixed size for consistent alignment
 */
const AnimatedSpinnerInline = () => (
  <span className="flex items-center justify-center w-[14px] h-[14px] flex-shrink-0 mt-[3px]">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <style>
        {`
          @keyframes spinnerRotate {
            to { transform: rotate(360deg); }
          }
          @keyframes spinnerDash {
            0% { stroke-dashoffset: 45; }
            50% { stroke-dashoffset: 15; }
            100% { stroke-dashoffset: 45; }
          }
          .spinner-inline {
            animation: spinnerRotate 1s linear infinite;
            transform-origin: center;
          }
          .spinner-inline .track { opacity: 0.2; }
          .spinner-inline .spin {
            stroke-dasharray: 60;
            stroke-dashoffset: 45;
            animation: spinnerDash 1.5s ease-in-out infinite;
          }
        `}
      </style>
      <g className="spinner-inline">
        <circle
          className="track"
          cx="12"
          cy="12"
          r="10"
          stroke="#8B5CF6"
          strokeWidth="2"
          fill="none"
        />
        <circle
          className="spin"
          cx="12"
          cy="12"
          r="10"
          stroke="#8B5CF6"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  </span>
);

/**
 * Check if content starts with a status marker
 */
function getStatusMarker(
  children: React.ReactNode,
): "check" | "spinner" | null {
  if (typeof children === "string") {
    if (children.startsWith("✓ ") || children.startsWith("✓")) return "check";
    if (children.startsWith("⏳ ") || children.startsWith("⏳"))
      return "spinner";
  }
  if (Array.isArray(children) && children.length > 0) {
    return getStatusMarker(children[0]);
  }
  return null;
}

/**
 * Strip status marker from text content
 */
function stripStatusMarker(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    return children.replace(/^[✓⏳]\s*/, "");
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (i === 0) return stripStatusMarker(child);
      return child;
    });
  }
  return children;
}

/**
 * Transform text content to replace emoji markers with animated icons (for non-paragraph contexts)
 */
function transformStatusMarkers(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    // Check for status markers at the start of the text
    if (children.startsWith("✓ ") || children.startsWith("✓")) {
      return (
        <>
          <AnimatedCheckInline />
          {children.replace(/^✓\s*/, "")}
        </>
      );
    }
    if (children.startsWith("⏳ ") || children.startsWith("⏳")) {
      return (
        <>
          <AnimatedSpinnerInline />
          {children.replace(/^⏳\s*/, "")}
        </>
      );
    }
    return children;
  }

  // Handle array of children (common with markdown)
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (i === 0) {
        return (
          <React.Fragment key={i}>
            {transformStatusMarkers(child)}
          </React.Fragment>
        );
      }
      return <React.Fragment key={i}>{child}</React.Fragment>;
    });
  }

  // Handle React elements with children
  if (React.isValidElement(children) && children.props.children) {
    return React.cloneElement(children, {
      ...children.props,
      children: transformStatusMarkers(children.props.children),
    });
  }

  return children;
}

export const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-base font-medium text-white/95 mb-2 mt-4 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-[15px] font-medium text-white/90 mt-3 mb-1.5">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-[14px] font-medium text-white/85 mt-2.5 mb-1">
      {children}
    </h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => {
    // Check if this paragraph starts with reasoning marker
    if (typeof children === "string" && children.startsWith("💭")) {
      const reasoningText = children.replace(/^💭\s*/, "");
      return (
        <p className="text-[14px] text-white/85 mb-2 leading-[1.7]">
          <ReasoningText>{reasoningText}</ReasoningText>
        </p>
      );
    }

    // Check for status markers - use flexbox for perfect alignment
    const marker = getStatusMarker(children);
    if (marker) {
      return (
        <p className="flex items-start gap-2 text-[14px] text-white/85 mb-2 leading-[1.7]">
          {marker === "check" ? (
            <AnimatedCheckInline />
          ) : (
            <AnimatedSpinnerInline />
          )}
          <span className="flex-1 min-w-0">{stripStatusMarker(children)}</span>
        </p>
      );
    }

    return (
      <p className="text-[14px] text-white/85 mb-2 leading-[1.7]">{children}</p>
    );
  },
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-2 ml-4 space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-2 ml-4 space-y-1 list-decimal">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-[14px] text-white/75 pl-1 list-item">{children}</li>
  ),
  code: ({
    className,
    children,
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="px-1.5 py-0.5 bg-sky-500/10 text-sky-300/90 text-[13px] font-mono rounded">
          {children}
        </code>
      );
    }
    return (
      <code className="block p-3 bg-[#0d1117] border border-white/[0.04] text-[#e6edf3] text-[13px] font-mono rounded-lg overflow-x-auto my-2">
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-[#0d1117] border border-white/[0.04] rounded-lg overflow-hidden my-2.5">
      {children}
    </pre>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-medium text-white/90">
      {transformStatusMarkers(children)}
    </strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => {
    // Check if this is reasoning text (starts with 💭)
    if (typeof children === "string" && children.startsWith("💭")) {
      const reasoningText = children.replace(/^💭\s*/, "");
      return (
        <em className="not-italic text-white/85">
          <ReasoningText>{reasoningText}</ReasoningText>
        </em>
      );
    }
    return <em className="text-white/80 italic">{children}</em>;
  },
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      className="text-sky-400/90 hover:text-sky-300 underline underline-offset-2 decoration-sky-400/30"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-white/20 pl-3 ml-[5px] my-2.5 text-white/75">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-white/[0.06] my-4" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-3 rounded-lg border border-white/[0.06]">
      <table className="w-full text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-white/[0.03]">{children}</thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <tbody className="divide-y divide-white/[0.04]">{children}</tbody>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="hover:bg-white/[0.02] transition-colors">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-2 text-left text-white/60 font-medium text-[12px]">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-2 text-white/55 text-[13px]">{children}</td>
  ),
};
