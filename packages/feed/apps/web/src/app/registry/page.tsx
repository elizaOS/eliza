import { redirect } from "next/navigation";

export default function RegistryRedirectPage() {
  redirect("/admin?tab=registry");
}
