import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import styles from "./page.module.css";

export default async function AppHomePage() {
  const user = await requireSessionUser();
  if (!user) {
    redirect("/login");
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.kicker}>Welcome back</p>
          <h1 className={styles.title}>{user.name ?? "Soulmates member"}</h1>
          <p className={styles.subtitle}>
            Manage your profile, credits, and access status from here.
          </p>
        </div>
        <div className={styles.heroCard}>
          <div className={styles.heroRow}>
            <span>Status</span>
            <span>{user.isAdmin ? "Admin" : user.status}</span>
          </div>
          <div className={styles.heroRow}>
            <span>Credits</span>
            <span>{user.credits}</span>
          </div>
          <div className={styles.heroRow}>
            <span>Phone</span>
            <span>{user.phone}</span>
          </div>
        </div>
      </section>

      <section className={styles.grid}>
        <Link className={styles.card} href="/app/profile">
          <h2>Profile</h2>
          <p>Review and update your basics before matching begins.</p>
        </Link>
        <Link className={styles.card} href="/app/billing">
          <h2>Credits</h2>
          <p>Top up credits and review your balance.</p>
        </Link>
        {user.isAdmin ? (
          <Link className={styles.card} href="/app/admin">
            <h2>Admin</h2>
            <p>Monitor members, matches, and safety operations.</p>
          </Link>
        ) : null}
      </section>
    </div>
  );
}
