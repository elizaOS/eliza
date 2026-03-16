import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { AdminRedemptionsWrapper } from "@/components/admin/redemptions-wrapper";

export const metadata: Metadata = {
  title: "Admin: Redemption Management",
  description: "Review and approve token redemption requests",
};

export const dynamic = "force-dynamic";

export default async function AdminRedemptionsPage() {
  await requireAdmin();
  return <AdminRedemptionsWrapper />;
}
