import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/session";
import AdminClient from "./admin-client";

export default async function AdminPage() {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/app");
  }
  return <AdminClient />;
}
