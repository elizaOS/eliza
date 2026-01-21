import Link from "next/link";
import { redirect } from "next/navigation";
import SignOutButton from "@/app/components/SignOutButton";
import { isAuthEnabled } from "@/lib/auth-mode";
import { requireSessionUser } from "@/lib/session";
import styles from "./layout.module.css";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authEnabled = isAuthEnabled();
  const user = await requireSessionUser();
  if (!user) {
    redirect("/login");
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          Soulmates
        </Link>
        <nav className={styles.nav}>
          <Link className={styles.navLink} href="/app">
            Dashboard
          </Link>
          <Link className={styles.navLink} href="/app/profile">
            Profile
          </Link>
          <Link className={styles.navLink} href="/app/billing">
            Credits
          </Link>
          {user.isAdmin ? (
            <Link className={styles.navLink} href="/app/admin">
              Admin
            </Link>
          ) : null}
        </nav>
        <div className={styles.userMeta}>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{user.name ?? user.phone}</div>
            <div className={styles.userSub}>
              {user.isAdmin
                ? "Admin"
                : user.status === "blocked"
                  ? "Blocked"
                  : "Active"}
            </div>
          </div>
          <SignOutButton authEnabled={authEnabled} />
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
