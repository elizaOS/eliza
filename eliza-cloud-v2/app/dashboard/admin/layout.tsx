import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin Panel",
  description:
    "Admin moderation panel for managing users, reviewing violations, and configuring platform settings.",
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
