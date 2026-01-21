import { NextResponse } from "next/server";
import type { UserRecord } from "@/lib/store";

export const unauthorized = () =>
  NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

export const forbidden = () =>
  NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

export const badRequest = (error: string, extras?: Record<string, unknown>) =>
  NextResponse.json({ ok: false, error, ...extras }, { status: 400 });

export const conflict = (error: string) =>
  NextResponse.json({ ok: false, error }, { status: 409 });

export const notFound = (error: string) =>
  NextResponse.json({ ok: false, error }, { status: 404 });

export const serverError = (error: string) =>
  NextResponse.json({ ok: false, error }, { status: 500 });

export const ok = <T>(data: T) => NextResponse.json({ ok: true, data });

export async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function toProfileData(user: UserRecord) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    email: user.email,
    location: user.location,
    credits: user.credits,
    status: user.status,
    isAdmin: user.isAdmin,
    allowlisted: user.status === "active",
  };
}
