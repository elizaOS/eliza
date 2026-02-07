import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Explorer",
  description:
    "Interactive API documentation and testing interface. Explore endpoints, test requests, and view OpenAPI specifications for elizaOS Cloud.",
};

export default function ApiExplorerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
