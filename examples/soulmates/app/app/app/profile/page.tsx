"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiResponse, ProfileData } from "@/types/api";
import styles from "./page.module.css";

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/profile");
        const payload = (await response.json()) as ApiResponse<ProfileData>;
        if (!payload.ok) {
          setError(payload.error);
          return;
        }
        setProfile(payload.data);
        setName(payload.data.name ?? "");
        setEmail(payload.data.email ?? "");
        setLocation(payload.data.location ?? "");
      } catch {
        setError("Unable to load profile.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          email: email.trim() || null,
          location: location.trim() || null,
        }),
      });
      const payload = (await response.json()) as ApiResponse<ProfileData>;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setProfile(payload.data);
      setStatus("Saved.");
    } catch {
      setError("Unable to save profile.");
    } finally {
      setSaving(false);
    }
  }, [email, location, name]);

  if (loading) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <h1>Profile</h1>
          <p>Keep your essentials current before matching starts.</p>
        </header>
        <div className={styles.card}>
          <p className={styles.loading}>Loading profile...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Profile</h1>
        <p>Keep your essentials current before matching starts.</p>
      </header>

      <section className={styles.card}>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Location</span>
            <input
              type="text"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Phone</span>
            <input type="text" value={profile?.phone ?? ""} disabled />
          </label>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
          {status ? <span className={styles.status}>{status}</span> : null}
          {error ? <span className={styles.error}>{error}</span> : null}
        </div>
      </section>
    </div>
  );
}
